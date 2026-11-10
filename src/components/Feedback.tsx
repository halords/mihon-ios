import { useEffect, useState } from 'react';
import Icon from './Icon';

export function toast(message: string): void { window.dispatchEvent(new CustomEvent('mihon:toast', { detail: message })); }
export function Toast() {
  const [message, setMessage] = useState('');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const receive = (event: Event) => { setMessage((event as CustomEvent<string>).detail); clearTimeout(timer); timer = setTimeout(() => setMessage(''), 4500); };
    window.addEventListener('mihon:toast', receive);
    return () => { window.removeEventListener('mihon:toast', receive); clearTimeout(timer); };
  }, []);
  return message ? <div className="toast" role="status">{message}<button className="icon-btn" aria-label="Dismiss message" onClick={() => setMessage('')}><Icon name="close" size={18} /></button></div> : null;
}
export function EmptyState({ icon = 'library', title, children }: { icon?: import('./Icon').IconName; title: string; children?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name={icon} size={38} /></div><h2>{title}</h2>{children}</div>;
}
