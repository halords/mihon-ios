import { useEffect, useRef, type ReactNode } from 'react';
import Icon from './Icon';
import { Toast } from './Feedback';

export default function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { dialog.close(); document.body.style.overflow = overflow; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className="sheet" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientY < rect.top || event.clientX < rect.left || event.clientX > rect.right || event.clientY > rect.bottom) onClose();
  }}>
    <div className="sheet-handle" />
    <div className="sheet-heading"><h2>{title}</h2><button className="icon-btn" aria-label="Close dialog" onClick={onClose}><Icon name="close" /></button></div>
    <div className="sheet-body">{children}</div>
    <Toast />
  </dialog>;
}
