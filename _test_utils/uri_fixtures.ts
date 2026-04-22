export type UriAcceptanceFixture = {
  input: string;
  url: string;
};

export const BARE_URI_ACCEPTANCE_FIXTURES: readonly UriAcceptanceFixture[] = [
  {
    input: 'Visit https://example.com now',
    url: 'https://example.com',
  },
  {
    input: 'Open file:///Users/example/report.txt now',
    url: 'file:///Users/example/report.txt',
  },
  {
    input: 'Contact mailto:editor@example.org next',
    url: 'mailto:editor@example.org',
  },
  {
    input: 'Catalog urn:isbn:0451450523 now',
    url: 'urn:isbn:0451450523',
  },
  {
    input: 'Call tel:+12025550123 next',
    url: 'tel:+12025550123',
  },
  {
    input: 'Load data:text/plain,hello now',
    url: 'data:text/plain,hello',
  },
  {
    input: 'Fetch magnet:?xt=urn:btih:abcdef now',
    url: 'magnet:?xt=urn:btih:abcdef',
  },
  {
    input: 'Launch foo+bar://example.service/path now',
    url: 'foo+bar://example.service/path',
  },
] as const;

export const BARE_URI_REJECTION_FIXTURES: readonly string[] = [
  'Reminder: check the corpus matrix',
  'note:abc',
  'chapter:one',
  'longcustomscheme:alpha',
  'abchttps://example.com',
  'Visit https://',
] as const;

export const EXPLICIT_URI_ACCEPTANCE_FIXTURES: readonly UriAcceptanceFixture[] = [
  {
    input: '[https://example.com Example]',
    url: 'https://example.com',
  },
  {
    input: '[http://[::1]:5000/connect/token Loopback]',
    url: 'http://[::1]:5000/connect/token',
  },
  {
    input: '[longcustomscheme:alpha Label]',
    url: 'longcustomscheme:alpha',
  },
  {
    input: '[note:abc Label]',
    url: 'note:abc',
  },
] as const;