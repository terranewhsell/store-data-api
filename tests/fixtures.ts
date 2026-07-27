/**
 * Fixtures.
 *
 * Trimmed but shape-faithful samples of what each source actually returns. The
 * Play one is modelled on the object the client pasted, which is the output of
 * google-play-scraper.
 */

export const PLAY_TRANSLATE: Record<string, unknown> = {
  title: 'Google Translate',
  description: 'Translate between 103 languages by typing\r\nTap to Translate',
  descriptionHTML: 'Translate between 103 languages by typing<br>Tap to Translate',
  summary: 'The world is closer than ever with over 100 languages',
  installs: '1,000,000,000+',
  minInstalls: 1000000000,
  maxInstalls: 1898626813,
  score: 4.482483,
  scoreText: '4.5',
  ratings: 6811669,
  reviews: 1614618,
  histogram: { '1': 370042, '2': 145558, '3': 375720, '4': 856865, '5': 5063481 },
  price: 0,
  free: true,
  currency: 'USD',
  priceText: 'Free',
  available: true,
  offersIAP: false,
  IAPRange: undefined,
  androidVersion: 'VARY',
  androidVersionText: 'Varies with device',
  androidMaxVersion: 'VARY',
  developer: 'Google LLC',
  developerId: '5700313618786177705',
  developerEmail: 'translate-android-support@google.com',
  developerWebsite: 'http://support.google.com/translate',
  developerAddress: '1600 Amphitheatre Parkway, Mountain View 94043',
  developerLegalName: undefined,
  developerLegalEmail: undefined,
  developerLegalAddress: undefined,
  developerLegalPhoneNumber: undefined,
  privacyPolicy: 'http://www.google.com/policies/privacy/',
  developerInternalID: '5700313618786177705',
  genre: 'Tools',
  genreId: 'TOOLS',
  categories: [
    { name: 'Tools', id: 'TOOLS' },
    { name: 'Another category without id', id: null },
  ],
  icon: 'https://lh3.googleusercontent.com/icon',
  headerImage: 'https://lh3.googleusercontent.com/header',
  screenshots: ['https://lh3.googleusercontent.com/s1', 'https://lh3.googleusercontent.com/s2'],
  video: undefined,
  videoImage: undefined,
  previewVideo: undefined,
  contentRating: 'Everyone',
  contentRatingDescription: undefined,
  adSupported: false,
  released: undefined,
  updated: 1576868577000,
  version: 'Varies with device',
  recentChanges: 'Improved offline translations &#8212; faster downloads',
  comments: [],
  preregister: false,
  earlyAccessEnabled: false,
  isAvailableInPlayPass: false,
  appId: 'com.google.android.apps.translate',
  url: 'https://play.google.com/store/apps/details?id=com.google.android.apps.translate&hl=en&gl=us',
}

/** A game, to exercise the type derivation. */
export const PLAY_GAME: Record<string, unknown> = {
  ...PLAY_TRANSLATE,
  title: 'Clash of Clans',
  appId: 'com.supercell.clashofclans',
  developer: 'Supercell',
  developerId: 'Supercell',
  genre: 'Strategy',
  genreId: 'GAME_STRATEGY',
  categories: [{ name: 'Strategy', id: 'GAME_STRATEGY' }],
  url: 'https://play.google.com/store/apps/details?id=com.supercell.clashofclans&hl=en&gl=us',
}

/** FAMILY is the ambiguous shelf: game or app depending on its sub-categories. */
export const PLAY_FAMILY_GAME: Record<string, unknown> = {
  ...PLAY_TRANSLATE,
  title: 'Toca Kitchen',
  appId: 'com.tocaboca.tocakitchen',
  genre: 'Family',
  genreId: 'FAMILY',
  categories: [
    { name: 'Family', id: 'FAMILY' },
    { name: 'Educational', id: 'GAME_EDUCATIONAL' },
  ],
}

export const PLAY_FAMILY_APP: Record<string, unknown> = {
  ...PLAY_TRANSLATE,
  title: 'Family Organiser',
  appId: 'com.example.familyorganiser',
  genre: 'Family',
  genreId: 'FAMILY',
  categories: [{ name: 'Family', id: 'FAMILY' }],
}

export const ITUNES_TRANSLATE = {
  trackId: 414706506,
  trackName: 'Google Translate',
  bundleId: 'com.google.Translate',
  artistId: 281956209,
  artistName: 'Google',
  sellerName: 'Google LLC',
  sellerUrl: 'https://translate.google.com',
  artistViewUrl: 'https://apps.apple.com/us/developer/google/id281956209',
  description: 'Translate between up to 108 languages.\nText translation.',
  releaseNotes: 'Bug fixes & improvements',
  version: '8.6.0',
  price: 0,
  formattedPrice: 'Free',
  currency: 'USD',
  averageUserRating: 4.6234,
  userRatingCount: 1234567,
  averageUserRatingForCurrentVersion: 4.7,
  userRatingCountForCurrentVersion: 4321,
  artworkUrl512: 'https://is1-ssl.mzstatic.com/512.png',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/100.png',
  screenshotUrls: ['https://is1-ssl.mzstatic.com/s1.png', 'https://is1-ssl.mzstatic.com/s2.png'],
  ipadScreenshotUrls: ['https://is1-ssl.mzstatic.com/ipad1.png'],
  appletvScreenshotUrls: [],
  genres: ['Reference', 'Productivity'],
  genreIds: ['6006', '6007'],
  primaryGenreName: 'Reference',
  primaryGenreId: 6006,
  trackContentRating: '4+',
  contentAdvisoryRating: '4+',
  advisories: [],
  languageCodesISO2A: ['EN', 'ES'],
  fileSizeBytes: '123456789',
  minimumOsVersion: '15.0',
  supportedDevices: ['iPhone5s-iPhone5s'],
  features: ['iosUniversal'],
  isGameCenterEnabled: false,
  currentVersionReleaseDate: '2026-06-01T12:00:00Z',
  releaseDate: '2008-07-11T07:00:00Z',
  trackViewUrl: 'https://apps.apple.com/us/app/google-translate/id414706506',
  kind: 'software',
}

export const ITUNES_GAME = {
  ...ITUNES_TRANSLATE,
  trackId: 529479190,
  trackName: 'Clash of Clans',
  bundleId: 'com.supercell.magic',
  artistName: 'Supercell',
  genres: ['Games', 'Strategy'],
  genreIds: ['6014', '7017'],
  primaryGenreName: 'Games',
  primaryGenreId: 6014,
  trackViewUrl: 'https://apps.apple.com/us/app/clash-of-clans/id529479190',
}

export const STEAM_TF2 = {
  type: 'game',
  name: 'Team Fortress 2',
  steam_appid: 440,
  required_age: 0,
  is_free: true,
  detailed_description: '<h1>Nine distinct classes</h1><p>Team Fortress 2 &amp; friends.</p>',
  short_description: 'Nine distinct classes provide a broad range of tactical abilities.',
  header_image: 'https://cdn.akamai.steamstatic.com/header.jpg',
  capsule_image: 'https://cdn.akamai.steamstatic.com/capsule.jpg',
  website: 'http://www.teamfortress.com/',
  developers: ['Valve'],
  publishers: ['Valve'],
  price_overview: undefined,
  platforms: { windows: true, mac: true, linux: true },
  metacritic: { score: 92, url: 'https://www.metacritic.com/game/pc/team-fortress-2' },
  categories: [
    { id: 1, description: 'Multi-player' },
    { id: 35, description: 'In-App Purchases' },
  ],
  genres: [
    { id: '1', description: 'Action' },
    { id: '71', description: 'Free to Play' },
  ],
  screenshots: [
    { id: 0, path_thumbnail: 'https://cdn/thumb0.jpg', path_full: 'https://cdn/full0.jpg' },
    { id: 1, path_thumbnail: 'https://cdn/thumb1.jpg', path_full: 'https://cdn/full1.jpg' },
  ],
  movies: [
    {
      id: 1,
      thumbnail: 'https://cdn/movie-thumb.jpg',
      webm: { '480': 'https://cdn/480.webm', max: 'https://cdn/max.webm' },
      mp4: { '480': 'https://cdn/480.mp4', max: 'https://cdn/max.mp4' },
    },
  ],
  release_date: { coming_soon: false, date: '10 Oct, 2007' },
  ratings: { esrb: { rating: 'm', descriptors: 'Blood and Gore' } },
  dlc: [12345],
  achievements: { total: 520 },
}

/** A paid title, so the minor-unit price conversion is exercised. */
export const STEAM_PAID = {
  ...STEAM_TF2,
  name: 'Portal 2',
  steam_appid: 620,
  is_free: false,
  price_overview: {
    currency: 'EUR',
    initial: 1999,
    final: 999,
    discount_percent: 50,
    final_formatted: '9,99€',
  },
  categories: [{ id: 2, description: 'Single-player' }],
}

export const STEAM_REVIEWS = {
  reviewScore: 9,
  reviewScoreDesc: 'Overwhelmingly Positive',
  totalPositive: 900,
  totalNegative: 100,
  totalReviews: 1000,
}
