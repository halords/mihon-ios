import { useState } from 'react';

const icons: Record<string, string> = {
  mangadex: 'mangadex', '2499283573021220255': 'mangadex',
  '4758858684982406533': 'mangahub', '2528986671771677900': 'mangakakalot',
  '993336618407081332': 'manhwa18', '4841602236575491202': 'manhwa18',
  '6247824327199706550': 'asura', '7798162483793432927': 'mangalife',
  '6484561431658238800': 'mangafox', '3112384885023225761': 'kissmanga',
};
function sourceIcon(id: string, name: string): string | undefined {
  const known = icons[id] ?? Object.values(icons).find(icon => (id + ' ' + name).toLowerCase().replace(/[^a-z0-9]/g, '').includes(icon));
  return known ? `/source-icons/${known}.png` : undefined;
}
export default function SourceLogo({ id, name, iconUrl }: { id: string; name: string; iconUrl?: string }) {
  const url = sourceIcon(id, name) ?? iconUrl;
  const [failed, setFailed] = useState('');
  return <span className="extension-avatar source-logo" aria-hidden="true">{url && failed !== url
    ? <img src={url} alt="" width="42" height="42" onError={() => setFailed(url)} />
    : <span className="source-monogram">{name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase() || '?'}</span>}</span>;
}
