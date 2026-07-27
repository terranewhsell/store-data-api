/**
 * Google Play top charts: TOP_FREE, TOP_PAID, GROSSING.
 *
 * These do not arrive with the category page. Play renders the labels server
 * side and fetches the entries afterwards through `batchexecute`, Google's
 * internal RPC transport, so there is no HTML to parse and no cluster link to
 * follow. Verified by looking: the category page carries the words "Top free"
 * and no app data underneath them, and no cluster token anywhere.
 *
 * So this speaks the RPC. The request is built here from its parts; only the
 * field mask is a transcribed constant, and it lives in `list-protocol.ts` with
 * an explanation of what it is. Everything else, the envelope, the pacing, the
 * block detection, the response parsing, is ours and can be changed without
 * asking anyone.
 *
 * The response is not JSON. It is a length-prefixed stream of chunks with a
 * `)]}'` guard on the front, which is why it needs its own reader below rather
 * than a call to JSON.parse.
 */
import { config } from '../../config.ts'
import { fetchText } from '../../lib/http.ts'
import { pacers } from '../../lib/pacer.ts'
import { SourceError } from '../../lib/source-errors.ts'
import { extractAppList, type ListedApp } from './lists.ts'
import {
  PLAY_LIST_ATTRIBUTE_IDS,
  PLAY_LIST_FIELD_MASK,
  PLAY_LIST_GROUPING,
  PLAY_LIST_RPC_ID,
} from './list-protocol.ts'

const ENDPOINT = 'https://play.google.com/_/PlayStoreUi/data/batchexecute'
export type PlayCollection = 'TOP_FREE' | 'TOP_PAID' | 'GROSSING'

/**
 * The names Google actually expects on the wire.
 *
 * `TOP_FREE` is the name the client asked for and the name this API serves. It
 * is not what the RPC understands. Send it and the call answers 200 with an
 * empty stream, and nothing anywhere says why.
 *
 * This single mapping was the whole reason charts did not work. The envelope,
 * the field mask, the response reader and the transport were all correct from
 * the start. It was found by capturing the bytes a working request actually
 * sends and diffing them against ours: 23,208 bytes against 23,201, identical
 * until byte 23,074, where one said `topselling_free` and the other `TOP_FREE`.
 *
 * Worth remembering the shape of that: hours went into cookies, HTTP versions,
 * user agents and query parameters, all of it guessing at a symptom. The diff
 * took two minutes and was conclusive.
 */
const WIRE_COLLECTION: Record<PlayCollection, string> = {
  TOP_FREE: 'topselling_free',
  TOP_PAID: 'topselling_paid',
  GROSSING: 'topgrossing',
}

export interface ChartParams {
  collection: PlayCollection
  category: string
  num: number
  lang: string
  country: string
}

/**
 * The RPC argument, assembled rather than pasted.
 *
 * Shape: `[[ null, <request options>, [2, collection, category] ]]`, where the
 * request options carry the page size, the attribute ids, the field mask and the
 * grouping.
 */
function buildRpcArgument(params: ChartParams): string {
  const requestOptions = [
    [8, [20, params.num]],
    true,
    null,
    PLAY_LIST_ATTRIBUTE_IDS,
    PLAY_LIST_FIELD_MASK,
    null,
    null,
    PLAY_LIST_GROUPING,
  ]

  return JSON.stringify([
    [null, requestOptions, [2, WIRE_COLLECTION[params.collection], params.category]],
  ])
}

function buildBody(params: ChartParams): string {
  const envelope = JSON.stringify([[[PLAY_LIST_RPC_ID, buildRpcArgument(params), null, 'generic']]])
  return `f.req=${encodeURIComponent(envelope)}`
}

/**
 * Reads a batchexecute response.
 *
 * The body starts with the `)]}'` anti-hijacking guard, then alternates a length
 * line with a JSON chunk. Each chunk is an array whose third element is itself
 * a JSON string: the actual payload. Only the chunk matching our RPC id matters.
 */
export function parseBatchExecute(text: string, rpcId: string): unknown {
  const cleaned = text.replace(/^\)\]\}'\s*/, '').trim()

  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('[')) continue

    let chunk: unknown
    try {
      chunk = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!Array.isArray(chunk)) continue

    for (const entry of chunk) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || entry[1] !== rpcId) continue
      const payload = entry[2]
      if (typeof payload !== 'string') continue
      try {
        return JSON.parse(payload)
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * One chart.
 *
 * An empty result is treated as a failure rather than as an empty chart: Play
 * has no empty charts, so nothing coming back means the request shape stopped
 * being accepted. Reporting that as "this category has no top free apps" would
 * be the silent-null failure this whole parser exists to avoid.
 */
export async function fetchChart(params: ChartParams): Promise<ListedApp[]> {
  /**
   * Three parameters. Everything else was cargo.
   *
   * Chasing the empty responses, this URL accumulated a session id, a build
   * label, client platform flags, a request counter, an `rt=c` response-format
   * selector, cookies from a warm-up fetch and three extra headers. Once the
   * real cause was found, each was removed and measured: the call works with
   * `rpcids`, `hl` and `gl` alone. None of the rest was ever doing anything.
   */
  const query = new URLSearchParams({
    rpcids: PLAY_LIST_RPC_ID,
    hl: params.lang,
    gl: params.country,
  })
  const url = `${ENDPOINT}?${query.toString()}`

  const text = await pacers.play.run(() =>
    fetchText('play', url, {
      method: 'POST',
      body: buildBody(params),
      timeoutMs: config.HTTP_TIMEOUT_MS,
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    }),
  )

  /**
   * A failure here must NOT trip the shared Play circuit breaker.
   *
   * The breaker exists to say "Google is refusing us", and opening it stops
   * every other Play request: listings, search, everything. This RPC failing
   * says something narrower and entirely about us, that our request shape is not
   * accepted, and letting that take the whole source down is how one
   * experimental code path poisons four working ones.
   *
   * Found exactly that way: a clean-clone ingest returned twelve Steam titles
   * and zero from Play, because the first chart attempt opened the breaker and
   * every listing fetch after it was refused before it left the process.
   */
  const payload = parseBatchExecute(text, PLAY_LIST_RPC_ID)
  if (payload === null) {
    throw new SourceError('play', 'malformed', 'Play chart RPC returned nothing usable.', {
      detail: { collection: params.collection, category: params.category, bytes: text.length },
    })
  }

  const apps = extractAppList(new Map([['chart', payload]]), {
    lang: params.lang,
    country: params.country,
    limit: params.num,
  })

  if (apps.length === 0) {
    throw new SourceError(
      'play',
      'malformed',
      'Play chart RPC returned no apps. Play publishes no empty charts, so the request shape is not being accepted.',
      { detail: { collection: params.collection, category: params.category } },
    )
  }

  return apps
}
