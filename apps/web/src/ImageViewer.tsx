import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Minus, Plus, X } from 'lucide-react';

export interface ViewerImage { id: string; url: string; label: string }

export function ImageViewer({ images, index, onIndex, onClose }: { images: ViewerImage[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const image = images[index]!;
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('resize', resize); previousFocus?.focus(); };
  }, []);
  useEffect(() => { setZoom(1); setNatural({ width: 0, height: 0 }); }, [image.url]);

  const fit = natural.width && natural.height ? Math.min(1, Math.max(1, viewport.width - 64) / natural.width, Math.max(1, viewport.height - 150) / natural.height) : 1;
  const width = natural.width ? Math.round(natural.width * fit * zoom) : undefined;
  const zoomBy = (delta: number) => setZoom(current => Math.min(4, Math.max(0.5, Math.round((current + delta) * 4) / 4)));
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); onIndex(index - 1); }
    if (event.key === 'ArrowRight' && index < images.length - 1) { event.preventDefault(); onIndex(index + 1); }
    if (event.key === 'Tab') {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };

  return createPortal(<div className="image-viewer" role="dialog" aria-modal="true" aria-label="Image viewer" onKeyDown={keyDown} onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="image-viewer-bar"><span>{images.length > 1 ? `Image ${index + 1} of ${images.length}` : 'Image'}</span><button ref={closeButton} type="button" className="image-viewer-control" aria-label="Close image viewer" title="Close (Esc)" onClick={onClose}><X size={20} /></button></div>
    <div className="image-viewer-stage" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><img src={image.url} alt={image.label} draggable={false} style={width ? { width, maxWidth: 'none', maxHeight: 'none' } : undefined} onLoad={event => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} /></div>
    <div className="image-viewer-controls">
      {images.length > 1 && <button type="button" className="image-viewer-control" aria-label="Previous image" disabled={index === 0} onClick={() => onIndex(index - 1)}><ChevronLeft size={19} /></button>}
      <button type="button" className="image-viewer-control" aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => zoomBy(-0.25)}><Minus size={18} /></button>
      <button type="button" className="image-viewer-zoom" aria-label="Fit image" title="Fit image" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button type="button" className="image-viewer-control" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => zoomBy(0.25)}><Plus size={18} /></button>
      {images.length > 1 && <button type="button" className="image-viewer-control" aria-label="Next image" disabled={index === images.length - 1} onClick={() => onIndex(index + 1)}><ChevronRight size={19} /></button>}
    </div>
  </div>, document.body);
}
