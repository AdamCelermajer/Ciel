import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface ComposerOption { value: string; label: string }

export function ComposerSelect({ label, value, options, onChange, disabled = false, className = '' }: {
  label: string;
  value: string;
  options: ComposerOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = Math.max(0, options.findIndex(option => option.value === value));

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    const frame = requestAnimationFrame(() => {
      const item = list.current?.querySelectorAll<HTMLElement>('[role="option"]')[selected];
      item?.focus();
      item?.scrollIntoView({ block: 'nearest' });
    });
    return () => { document.removeEventListener('pointerdown', outside); cancelAnimationFrame(frame); };
  }, [open, selected]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const choose = (next: string) => { onChange(next); setOpen(false); trigger.current?.focus(); };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault(); setOpen(true); return;
    }
    if (!open) return;
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]') || []);
    const current = Math.max(0, items.indexOf(document.activeElement as HTMLElement));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const item = document.activeElement as HTMLElement;
      const index = items.indexOf(item);
      if (index >= 0) choose(options[index].value);
    }
  };

  return <div className={`composer-picker ${className} ${open ? 'open' : ''}`} ref={root} onKeyDown={onKeyDown}>
    <button ref={trigger} type="button" className="composer-picker-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled} onClick={() => setOpen(current => !current)}>
      <span>{options.find(option => option.value === value)?.label ?? value}</span><ChevronDown size={14} aria-hidden="true" />
    </button>
    {open && <div ref={list} id={id} role="listbox" aria-label={label} className="composer-picker-menu">
      <div className="composer-picker-heading" role="presentation">{label}</div>
      {options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} tabIndex={-1} className="composer-picker-option" onClick={() => choose(option.value)}><span>{option.label}</span>{option.value === value && <Check size={14} aria-hidden="true" />}</button>)}
    </div>}
  </div>;
}
