import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ChevronRight, Folder, FolderOpen, LoaderCircle, Plus, X } from 'lucide-react';
import { api } from './api';

interface FolderList { path: string; parent: string | null; directories: string[] }

export function AddProjectDialog({ hostId, hostName, local, busy, onClose, onCreate }: {
  hostId: string; hostName: string; local: boolean; busy: boolean;
  onClose: () => void; onCreate: (name: string, folder: string) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [folders, setFolders] = useState<FolderList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => { nameInput.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (browsing) setBrowsing(false); else if (!busy) onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [browsing, busy, onClose]);

  const choose = (path: string) => {
    setFolder(path);
    if (!nameEdited) setName(path.split(/[\\/]/).filter(Boolean).at(-1) || path);
    setBrowsing(false); setError('');
  };
  const openFolder = async (path?: string) => {
    setBrowsing(true); setLoading(true); setFolders(null); setError('');
    try { setFolders(await api.projectFolders(hostId, path)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Cannot open folder'); }
    finally { setLoading(false); }
  };
  const browse = async () => {
    if (local) {
      setLoading(true); setError('');
      try {
        const picked = await api.pickProjectFolder(hostId);
        if (picked.path) choose(picked.path);
        return;
      } catch { /* Use the host folder browser when the native picker is unavailable. */ }
      finally { setLoading(false); }
    }
    await openFolder(folder || undefined);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !folder.trim() || busy) return;
    setError('');
    try { if (await onCreate(name.trim(), folder.trim())) onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add project'); }
  };

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal project-dialog" role="dialog" aria-modal="true" aria-label={browsing ? 'Choose a folder' : 'Add project'}>
      <div className="modal-head"><h2>{browsing ? 'Choose a folder' : 'Add project'}</h2><button type="button" className="icon-button" aria-label="Close add project" onClick={onClose} disabled={busy}><X size={18} /></button></div>
      {browsing ? <>
        <p className="project-dialog-help">Browse folders on {hostName}.</p>
        <div className="folder-location"><button type="button" className="icon-button" aria-label="Parent folder" disabled={!folders?.parent || loading} onClick={() => void openFolder(folders?.parent || undefined)}><ArrowLeft size={17} /></button><span title={folders?.path}>{folders?.path || 'Loading…'}</span></div>
        <div className="folder-list" role="list" aria-label="Folders">{loading ? <div className="folder-loading"><LoaderCircle className="spin" size={20} />Loading folders…</div> : folders?.directories.length ? folders.directories.map(item => <button type="button" key={item} onClick={() => void openFolder(`${folders.path.replace(/[\\/]$/, '')}/${item}`)}><Folder size={17} /><span>{item}</span><ChevronRight size={16} /></button>) : <p>No subfolders here.</p>}</div>
        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setBrowsing(false)}>Back</button><button type="button" className="primary-button" disabled={!folders || loading} onClick={() => folders && choose(folders.path)}><FolderOpen size={16} />Choose this folder</button></div>
      </> : <>
        <p className="project-dialog-help">Add a folder from {hostName}. The name is only how it appears in CIEL.</p>
        <form onSubmit={event => void submit(event)}>
          <label>Project name<input ref={nameInput} required maxLength={120} value={name} onChange={event => { setNameEdited(true); setName(event.target.value); }} placeholder="My project" /></label>
          <label>Folder<div className="project-folder-control"><input required value={folder} onChange={event => setFolder(event.target.value)} placeholder="Choose a folder" aria-label="Project folder" /><button type="button" className="secondary-button" disabled={loading || busy} onClick={() => void browse()}>{loading ? <LoaderCircle size={15} className="spin" /> : <FolderOpen size={15} />}Browse…</button></div></label>
          {error && <p className="project-dialog-error" role="alert">{error}</p>}
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary-button" disabled={busy || !name.trim() || !folder.trim()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}Add project</button></div>
        </form>
      </>}
    </section>
  </div>;
}
