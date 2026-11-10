// Source identities from the supplied Mihon backup. Keep the signed 64-bit
// values as strings so both library keys and Android exports remain exact.
export interface BackupSourceConfig {
  id: string;
  name: string;
  baseUrl: string;
  hosts: string[];
  imageHosts: string[];
}
export const backupSourceConfigs: BackupSourceConfig[] = [
  { id: '4758858684982406533', name: 'MangaHub', baseUrl: 'https://mangahub.io', hosts: ['mangahub.io', 'api.mghcdn.com'], imageHosts: ['mghcdn.com'] },
  { id: '2528986671771677900', name: 'Mangakakalot', baseUrl: 'https://www.kakamanga.com', hosts: ['kakamanga.com', 'mangakakalove.com', 'mangakakalot.com', 'manganato.com', 'manganato.to', 'chapmanganato.to'], imageHosts: ['kakamanga.com', 'mangakakalove.com', 'mangakakalot.com', 'mkklcdnv6temp.com', 'mkklcdnv8.com', 'mkklcdnv9.com', 'readkakalot.com', '2xstorage.com', 'waitst.com'] },
  { id: '993336618407081332', name: 'Manhwa18.cc', baseUrl: 'https://manhwa18.cc', hosts: ['manhwa18.cc'], imageHosts: ['manhwa18.cc'] },
  { id: '4841602236575491202', name: 'Manhwa18.cc (legacy)', baseUrl: 'https://manhwa18.cc', hosts: ['manhwa18.cc'], imageHosts: ['manhwa18.cc'] },
  { id: '6247824327199706550', name: 'Asura Scans', baseUrl: 'https://asurascans.com', hosts: ['asurascans.com', 'asuracomic.net', 'asuratoon.com'], imageHosts: ['asurascans.com', 'asuracomic.net', 'asuratoon.com'] },
  { id: '7798162483793432927', name: 'MangaLife', baseUrl: 'https://mangalife.us', hosts: ['mangalife.us'], imageHosts: ['mangalife.us', 'manga4life.com', 'mangasee123.com', 'planeptune.us', 'nep.li'] },
  { id: '6484561431658238800', name: 'MangaFox', baseUrl: 'https://fanfox.net', hosts: ['fanfox.net'], imageHosts: ['fanfox.net', 'dmcdn.net', 'dm5.com', 'mfcdn.net', 'mangafox.me'] },
  { id: '3112384885023225761', name: 'Kissmanga.in', baseUrl: 'https://kissmanga.in', hosts: ['kissmanga.in'], imageHosts: ['kissmanga.in'] },
];

export function hostMatches(host: string, domain: string): boolean { return host === domain || host.endsWith('.' + domain); }
export function allowedSourceUrl(config: BackupSourceConfig, url: URL, images = false): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
    (images ? [...config.hosts, ...config.imageHosts] : config.hosts).some(domain => hostMatches(url.hostname, domain));
}
export function backupSourceConfig(id: string): BackupSourceConfig {
  const config = backupSourceConfigs.find(source => source.id === id);
  if (!config) throw new Error('Unknown built-in source');
  return config;
}
