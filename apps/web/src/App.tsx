import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity, ArrowDownToLine, ArrowRight, Bell, BookOpen, Bot, Check, CheckCheck,
  ChevronDown, CircleAlert, CircleCheck, CircleHelp, Cloud, Code2, Command, Cpu,
  Ellipsis, ExternalLink, FileCode, FileDiff, Folder, FolderPlus, House, KeyRound,
  Laptop, LoaderCircle, Menu, MessageSquare, Monitor, Pause, Pencil, Plus,
  RefreshCw, Search, Send, Server, Settings2, ShieldCheck, Sparkles, Square,
  Trash2, Wifi, WifiOff, X,
} from 'lucide-react';
import type {
  AuthFlow, CielUpdateStatus, EngineId, EngineStatus, HostConnection, HostEvent, HostState, LibraryItem,
  Message, PermissionMode, Preview, Project, Run, Task, TaskDetail,
} from '@ciel/contracts';
import { api, hostPath, type RuntimeState } from './api';
import { RunActivity } from './RunActivity';
import { ImageViewer, type ViewerImage } from './ImageViewer';
import { HostScope, isUnread, notificationKey, visibleAttentionSeq } from './isolation';

type View = 'sessions' | 'projects' | 'agents' | 'library' | 'hosts' | 'settings';
const engineNames: Record<EngineId, string> = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' };
const formatTime = (date: string) => { const n = new Date(date).getTime(); if (!Number.isFinite(n)) return ''; const delta = Math.max(0, Date.now() - n); if (delta < 60000) return 'just now'; if (delta < 3600000) return `${Math.floor(delta / 60000)}m ago`; if (delta < 86400000) return `${Math.floor(delta / 3600000)}h ago`; return new Date(date).toLocaleDateString(); };
const isBusy = (task: Task) => task.status === 'running' || task.status === 'queued' || task.status === 'waiting';
const taskTone = (task: Task) => ['waiting', 'failed', 'interrupted', 'cancelled'].includes(task.status) ? 'attention' : task.status === 'completed' ? 'completed' : task.status;
const engineReady = (engine?: EngineStatus) => !!engine?.installed && !!engine?.authenticated;
const newId = () => crypto.randomUUID();
const loadDrafts = (hostId: string): Record<string, string> => { try { const value = JSON.parse(localStorage.getItem(`ciel:drafts:${hostId}`) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {}; } catch { return {}; } };

function Logo({ updateAction }: { updateAction?: ReactNode }) { return <div className="brand"><img src="/ciel.svg" alt="" /><div><div className="brand-title"><strong>CIEL</strong>{updateAction}</div><span>Your code, everywhere</span></div></div>; }
function IconButton({ label, children, onClick, className = '', disabled = false }: { label: string; children: ReactNode; onClick: () => void; className?: string; disabled?: boolean }) { return <button className={`icon-button ${className}`} type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>; }
function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) { return <div className="empty"><div className="empty-icon">{icon}</div><h3>{title}</h3>{children && <p>{children}</p>}</div>; }
function EngineBadge({ engine }: { engine: EngineId }) { return <span className={`engine-badge ${engine}`}><Bot size={14} />{engineNames[engine]}</span>; }
function Status({ task }: { task: Task }) {
  const tone = taskTone(task);
  const label = task.status === 'running' ? 'Running' : task.status === 'queued' ? 'Queued' : task.status === 'completed' ? isUnread(task) ? 'Completed, unread' : 'Completed' : task.status === 'waiting' ? 'Needs input' : task.status === 'failed' ? 'Failed' : task.status === 'interrupted' ? 'Interrupted' : task.status === 'cancelled' ? 'Cancelled' : 'Idle';
  const busy = task.status === 'running' || task.status === 'queued';
  const Icon = busy ? LoaderCircle : tone === 'completed' ? CheckCheck : tone === 'attention' ? CircleAlert : CircleCheck;
  return <span className={`status ${tone} ${task.status === 'completed' && !isUnread(task) ? 'read' : ''}`}>{task.status !== 'completed' || isUnread(task) ? <Icon size={14} className={busy ? 'spin' : ''} /> : null}{label}</span>;
}
function CompactStatus({ task }: { task: Task }) {
  const tone = taskTone(task);
  const label = task.status === 'running' ? 'Running' : task.status === 'queued' ? 'Queued' : task.status === 'completed' ? isUnread(task) ? 'Completed, unread' : 'Completed' : task.status === 'waiting' ? 'Needs input' : task.status === 'failed' ? 'Failed, needs attention' : task.status === 'interrupted' ? 'Interrupted, needs attention' : task.status === 'cancelled' ? 'Cancelled' : 'Idle';
  const Icon = task.status === 'running' || task.status === 'queued' ? LoaderCircle : task.status === 'completed' ? Check : tone === 'attention' ? CircleAlert : CircleCheck;
  return <span className={`compact-status ${tone} ${task.status === 'completed' && !isUnread(task) ? 'read' : ''}`} title={label} aria-label={label}>{task.status !== 'completed' || isUnread(task) ? <Icon size={14} className={task.status === 'running' || task.status === 'queued' ? 'spin' : ''} /> : null}</span>;
}

export default function App() {
  const [hosts, setHosts] = useState<HostConnection[]>([]);
  const [hostId, setHostId] = useState('');
  const [bootError, setBootError] = useState('');
  const [booting, setBooting] = useState(true);
  const refreshHosts = useCallback(async () => { const list = await api.hosts(); setHosts(list); return list; }, []);
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const boot = await api.bootstrap(controller.signal);
        const list = await api.hosts(controller.signal);
        if (controller.signal.aborted) return;
        setHosts(list);
        const saved = sessionStorage.getItem('ciel:selected-host') || localStorage.getItem('ciel:selected-host');
        const initialHost = list.some(host => host.id === saved) ? saved! : list.some(host => host.id === boot.hostId) ? boot.hostId : list[0]?.id || '';
        if (initialHost) sessionStorage.setItem('ciel:selected-host', initialHost);
        setHostId(initialHost);
      } catch (error) { if (!controller.signal.aborted) setBootError(error instanceof Error ? error.message : 'Cannot connect to CIEL'); }
      finally { if (!controller.signal.aborted) setBooting(false); }
    })();
    return () => controller.abort();
  }, []);
  const selectHost = (id: string) => { sessionStorage.setItem('ciel:selected-host', id); localStorage.setItem('ciel:selected-host', id); setHostId(id); };
  if (booting) return <div className="boot"><Logo /><LoaderCircle className="spin" /><p>Connecting to CIEL…</p></div>;
  if (bootError) return <div className="boot"><Logo /><CircleAlert /><h2>CIEL is unavailable</h2><p>{bootError}</p><button onClick={() => location.reload()}>Retry connection</button></div>;
  if (!hostId) return <div className="boot"><Logo /><Empty icon={<Server />} title="No hosts yet">Start the CIEL host service on this computer to connect.</Empty></div>;
  return <Workspace key={hostId} hostId={hostId} hosts={hosts} selectHost={selectHost} refreshHosts={refreshHosts} />;
}

function Workspace({ hostId, hosts, selectHost, refreshHosts }: { hostId: string; hosts: HostConnection[]; selectHost: (id: string) => void; refreshHosts: () => Promise<HostConnection[]> }) {
  const scope = useRef(new HostScope());
  const [state, setState] = useState<HostState | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [view, setView] = useState<View>('sessions');
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [selectedTask, setSelectedTask] = useState<string>('');
  const [search, setSearch] = useState('');
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [engines, setEngines] = useState<EngineStatus[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeState[]>([]);
  const [network, setNetwork] = useState<{ url?: string; port?: number }>({});
  const [updateStatus, setUpdateStatus] = useState<CielUpdateStatus | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => loadDrafts(hostId));
  const [nextEngine, setNextEngine] = useState<EngineId>('codex');
  const [nextModel, setNextModel] = useState('');
  const [nextEffort, setNextEffort] = useState('');
  const [nextPermission, setNextPermission] = useState<PermissionMode>('full-access');
  const [busyAction, setBusyAction] = useState('');
  const creatingRef = useRef(false);
  const [notificationEnabled, setNotificationEnabled] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === 'visible');
  const notificationsRef = useRef(false);
  notificationsRef.current = notificationEnabled;
  const detailController = useRef<AbortController | null>(null);
  const selectedTaskRef = useRef(selectedTask);
  selectedTaskRef.current = selectedTask;
  function selectTask(task: Task) {
    if (selectedTaskRef.current !== task.id) {
      setNextEngine(task.engine); setNextModel(task.model || ''); setNextEffort(task.effort || ''); setNextPermission(task.permission);
    }
    selectedTaskRef.current = task.id;
    setSelectedTask(task.id);
  }
  const stateRef = useRef(state);
  stateRef.current = state;
  const notificationKeys = useRef(new Set<string>());
  useEffect(() => { localStorage.setItem(`ciel:drafts:${hostId}`, JSON.stringify(drafts)); }, [hostId, drafts]);
  useEffect(() => { const update = () => setPageVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const check = () => { if (document.visibilityState === 'visible') void api.updateStatus(hostId, controller.signal).then(setUpdateStatus).catch(() => undefined); };
    check();
    const timer = window.setInterval(check, 5 * 60 * 1000);
    document.addEventListener('visibilitychange', check);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [hostId]);

  const applyCielUpdate = async () => {
    if (!updateStatus?.latestVersion || applyingUpdate) return;
    const targetVersion = updateStatus.latestVersion;
    setApplyingUpdate(true); setActionError('');
    try {
      await api.applyUpdate(hostId);
      for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const latest = await api.updateStatus(hostId);
          if (latest.currentVersion === targetVersion) { location.reload(); return; }
        } catch { /* The host is restarting. */ }
      }
      throw new Error('CIEL did not reconnect after the update. Check the host service and try again.');
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Could not update CIEL');
      setUpdateOpen(false);
    } finally { setApplyingUpdate(false); }
  };

  const refreshState = useCallback(async () => {
    const selection = scope.current.capture(); if (!selection) return;
    try {
      const result = await api.state(selection.hostId, selection.controller.signal);
      if (!scope.current.isCurrent(selection)) return;
      setState(previous => !previous || result.lastSeq >= previous.lastSeq ? result : previous);
      setEngines(result.engines);
      setError(''); setLoading(false);
    } catch (cause) {
      if (scope.current.isCurrent(selection)) { setError(cause instanceof Error ? cause.message : 'Host is unavailable'); setState(null); setDetail(null); setLoading(false); }
    }
  }, []);

  const refreshDetail = useCallback(async (taskId: string) => {
    const selection = scope.current.capture(); if (!selection || !taskId) return;
    detailController.current?.abort();
    const controller = new AbortController(); detailController.current = controller;
    setDetailLoading(true);
    try {
      const result = await api.task(selection.hostId, taskId, controller.signal);
      if (scope.current.isCurrent(selection) && !controller.signal.aborted && selectedTaskRef.current === taskId) setDetail(result);
    } catch (cause) {
      if (scope.current.isCurrent(selection) && !controller.signal.aborted) setActionError(cause instanceof Error ? cause.message : 'Could not load task');
    } finally { if (scope.current.isCurrent(selection) && !controller.signal.aborted) setDetailLoading(false); }
  }, []);

  useEffect(() => {
    const selection = scope.current.switchTo(hostId);
    setState(null); setDetail(null); setEngines([]); setRuntimes([]); setNetwork({}); setError(''); setActionError(''); setSelectedTask(''); setSelectedProject(''); setNextModel(''); setNextEffort(''); notificationKeys.current.clear();
    let source: EventSource | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let suppressNotifications = false;
    let notificationFloor = 0;
    (async () => {
      try {
        const initial = await api.state(selection.hostId, selection.controller.signal);
        if (!scope.current.isCurrent(selection)) return;
        setState(initial); setEngines(initial.engines); setLoading(false);
        setNextPermission(initial.settings.defaultPermission);
        setNotificationEnabled(initial.settings.notifications && 'Notification' in window && Notification.permission === 'granted');
        const firstProject = initial.projects[0];
        const firstTask = initial.tasks.find(task => !task.archived && task.status === 'running') || initial.tasks.find(task => !task.archived);
        if (firstTask || firstProject) setSelectedProject(firstTask?.projectId || firstProject!.id);
        if (firstTask) selectTask(firstTask);
        // The cursor starts at the state snapshot. Replayed history is never a new notification.
        source = new EventSource(`${hostPath(selection.hostId)}/events?after=${initial.lastSeq}`);
        notificationFloor = initial.lastSeq;
        source.onerror = () => { suppressNotifications = true; };
        source.onopen = () => {
          if (!suppressNotifications) return;
          void api.state(selection.hostId, selection.controller.signal).then(snapshot => {
            if (!scope.current.isCurrent(selection)) return;
            notificationFloor = Math.max(notificationFloor, snapshot.lastSeq);
            setState(previous => !previous || snapshot.lastSeq >= previous.lastSeq ? snapshot : previous);
            if (selectedTaskRef.current) void refreshDetail(selectedTaskRef.current);
            suppressNotifications = false;
          }).catch(() => undefined);
        };
        const onEvent = (message: MessageEvent) => {
          if (!scope.current.isCurrent(selection)) return;
          let event: HostEvent;
          try { event = JSON.parse(message.data) as HostEvent; } catch { return; }
          if (event.hostId !== selection.hostId || event.seq <= initial.lastSeq) return;
          const current = stateRef.current;
          if (current && event.seq <= current.lastSeq) return;
          if (!suppressNotifications && event.seq > notificationFloor && current?.settings.notifications && notificationsRef.current && document.hidden && Notification.permission === 'granted' && /completed|failed|waiting|attention|approval.requested/.test(event.type)) {
            const key = notificationKey(selection.hostId, event);
            if (!notificationKeys.current.has(key)) {
              notificationKeys.current.add(key);
              const task = current.tasks.find(item => item.id === event.taskId);
              new Notification(task?.title || 'CIEL task update', { body: event.type.replace(/[._]/g, ' '), tag: key });
            }
          }
          if (event.taskId && event.taskId === selectedTaskRef.current) {
            setDetail(previous => previous && previous.task.id === event.taskId && !previous.events.some(item => item.seq === event.seq) ? { ...previous, events: [...previous.events, event] } : previous);
          }
          if (!refreshTimer) refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            if (!scope.current.isCurrent(selection)) return;
            if (selectedTaskRef.current) void refreshDetail(selectedTaskRef.current);
            void refreshState();
          }, 100);
        };
        source.onmessage = onEvent;
        for (const name of ['host-event', 'event', 'task.updated', 'run.updated', 'run.completed', 'run.failed', 'run.waiting', 'text.delta', 'message.delta']) source.addEventListener(name, onEvent as EventListener);
      } catch (cause) {
        if (scope.current.isCurrent(selection)) { setError(cause instanceof Error ? cause.message : 'Host is unavailable'); setLoading(false); }
      }
    })();
    void api.runtimes(selection.hostId, selection.controller.signal).then(value => { if (scope.current.isCurrent(selection)) setRuntimes(value); }).catch(() => undefined);
    void api.engines(selection.hostId, selection.controller.signal).then(value => { if (scope.current.isCurrent(selection)) setEngines(value); }).catch(() => undefined);
    void api.network(selection.hostId).then(value => { if (scope.current.isCurrent(selection)) setNetwork(value); }).catch(() => undefined);
    return () => { source?.close(); clearTimeout(refreshTimer); detailController.current?.abort(); scope.current.clear(); };
  }, [hostId, refreshDetail, refreshState]);

  useEffect(() => {
    if (view !== 'agents' && !runtimes.some(runtime => runtime.state === 'installing' || runtime.state === 'checking')) return;
    const timer = setInterval(() => {
      const selection = scope.current.capture(); if (!selection) return;
      void Promise.all([api.engines(selection.hostId, selection.controller.signal), api.runtimes(selection.hostId, selection.controller.signal)]).then(([nextEngines, nextRuntimes]) => {
        if (scope.current.isCurrent(selection)) { setEngines(nextEngines); setRuntimes(nextRuntimes); }
      }).catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [view, runtimes]);

  useEffect(() => { if (selectedTask) { setDetail(null); void refreshDetail(selectedTask); } else setDetail(null); }, [selectedTask, refreshDetail]);
  useEffect(() => {
    if (view !== 'sessions' || !state || !detail || !selectedTask) return;
    const task = state.tasks.find(item => item.id === selectedTask); if (!task) return;
    const seq = visibleAttentionSeq(task, detail); if (seq === null) return;
    const selection = scope.current.capture(); if (!selection) return;
    const frame = requestAnimationFrame(() => {
      if (scope.current.isCurrent(selection) && selectedTaskRef.current === task.id && pageVisible) {
        void api.readTask(selection.hostId, task.id, seq).then(updated => {
          if (scope.current.isCurrent(selection)) setState(previous => previous && ({ ...previous, tasks: previous.tasks.map(item => item.id === task.id ? updated : item) }));
        }).catch(() => undefined);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [state, detail, selectedTask, view, pageVisible]);

  const act = async (key: string, operation: (capturedHost: string) => Promise<unknown>, after?: () => void) => {
    const selection = scope.current.capture(); if (!selection) return;
    setActionError(''); setBusyAction(key);
    try { await operation(selection.hostId); if (scope.current.isCurrent(selection)) { after?.(); await refreshState(); if (selectedTaskRef.current) await refreshDetail(selectedTaskRef.current); } }
    catch (cause) { if (scope.current.isCurrent(selection)) setActionError(cause instanceof Error ? cause.message : 'Action failed'); }
    finally { if (scope.current.isCurrent(selection)) setBusyAction(''); }
  };

  const selected = state?.tasks.find(task => task.id === selectedTask) || null;
  const project = state?.projects.find(item => item.id === selected?.projectId) || null;
  const engine = engines.find(item => item.id === nextEngine);
  const models = engine?.models || [];
  const run = detail?.runs.at(-1);
  const createTask = async (projectId?: string) => {
    if (!projectId) { setView('projects'); return; }
    if (creatingRef.current) return;
    const selection = scope.current.capture(); if (!selection) return;
    creatingRef.current = true;
    setBusyAction('create-task'); setActionError('');
    try {
      const previous = selected || state?.tasks.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const engineId = selected ? nextEngine : previous?.engine || engines.find(engineReady)?.id || 'codex';
      const model = selected ? nextModel : previous?.model || '';
      const effort = selected ? nextEffort : previous?.effort || '';
      const permission = selected ? nextPermission : previous?.permission || state?.settings.defaultPermission || 'full-access';
      const task = await api.createTask(selection.hostId, { projectId, title: 'New session', engine: engineId, model: model || undefined, effort: effort || undefined, permission });
      if (scope.current.isCurrent(selection)) { selectTask(task); setSelectedProject(projectId); setExpandedProjects(previous => ({ ...previous, [projectId]: true })); setView('sessions'); await refreshState(); }
    } catch (cause) { if (scope.current.isCurrent(selection)) setActionError(cause instanceof Error ? cause.message : 'Could not create task'); }
    finally { creatingRef.current = false; if (scope.current.isCurrent(selection)) setBusyAction(''); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!selected) return;
    const prompt = (drafts[selected.id] || '').trim(); if (!prompt) return;
    if (!engineReady(engine)) { setActionError(`${engineNames[nextEngine]} needs setup in Settings → Agents & accounts before it can run.`); return; }
    const selection = scope.current.capture(); if (!selection) return;
    const destinationTask = selected.id;
    setBusyAction('submit'); setActionError('');
    try {
      await api.submitRun(selection.hostId, destinationTask, { prompt, commandId: newId(), engine: nextEngine, model: nextModel || null, effort: nextEffort || null, permission: nextPermission });
      if (scope.current.isCurrent(selection)) { setDrafts(previous => ({ ...previous, [destinationTask]: '' })); await refreshState(); await refreshDetail(destinationTask); }
    } catch (cause) { if (scope.current.isCurrent(selection)) setActionError(cause instanceof Error ? cause.message : 'Could not start run'); }
    finally { if (scope.current.isCurrent(selection)) setBusyAction(''); }
  };
  const chooseTask = (task: Task) => { selectTask(task); setSelectedProject(task.projectId); setView('sessions'); setSidebarOpen(false); };
  const chooseProject = (item: Project) => { setSelectedProject(item.id); setExpandedProjects(previous => ({ ...previous, [item.id]: true })); setView('sessions'); setSidebarOpen(false); };
  const toggleProject = (item: Project) => { setSelectedProject(item.id); setExpandedProjects(previous => ({ ...previous, [item.id]: previous[item.id] === false })); };
  const visibleTasks = useMemo(() => (state?.tasks || []).filter(task => !task.archived && (!search || `${task.title} ${engineNames[task.engine]}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [state, search]);
  const currentHost = hosts.find(host => host.id === hostId);
  const openView = (next: View) => { setView(next); setSidebarOpen(false); };

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="sidebar-head"><Logo updateAction={updateStatus?.available && updateStatus.supported && <button className="update-badge" type="button" title={`CIEL ${updateStatus.latestVersion} is available on ${currentHost?.name || 'this host'}`} onClick={() => setUpdateOpen(true)}><ArrowDownToLine size={13} />Update</button>} /><IconButton label="Close menu" className="mobile-only" onClick={() => setSidebarOpen(false)}><X size={20} /></IconButton></div>
      <nav className="primary-nav" aria-label="Main navigation">
        {([['sessions', MessageSquare, 'Sessions'], ['library', BookOpen, 'Skills Library'], ['settings', Settings2, 'Settings']] as const).map(([id, Icon, label]) => <button key={id} className={`nav-item ${view === id || id === 'settings' && ['projects', 'agents', 'hosts'].includes(view) ? 'selected' : ''}`} onClick={() => openView(id)}><Icon size={18} />{label}{id === 'sessions' && state && <span className="nav-count">{state.tasks.filter(task => !task.archived).length}</span>}{id === 'sessions' && state && state.tasks.some(task => !task.archived && isUnread(task)) && <span className="unread-count">{state.tasks.filter(task => !task.archived && isUnread(task)).length} new</span>}</button>)}
      </nav>
      <div className="sidebar-section project-tree"><div className="section-title">Projects <IconButton label="Add project" onClick={() => openView('projects')}><Plus size={16} /></IconButton></div>
        <label className="sidebar-search"><Search size={15} /><input aria-label="Search sessions" placeholder="Search sessions" value={search} onChange={event => setSearch(event.target.value)} /></label>
        {(state?.projects || []).map(item => <div key={item.id} className="project-group"><div className="project-group-head"><button aria-label={`Project ${item.name}`} aria-expanded={expandedProjects[item.id] !== false} className={`project-link ${selectedProject === item.id ? 'selected' : ''}`} onClick={() => toggleProject(item)}><ChevronDown size={14} className={expandedProjects[item.id] === false ? 'collapsed' : ''} /><Folder size={15} /><span>{item.name}</span>{state?.tasks.some(task => task.projectId === item.id && !task.archived && isUnread(task)) && <span className="project-unread" aria-label="Unread result" />}</button><IconButton label={`New session in ${item.name}`} disabled={busyAction === 'create-task'} onClick={() => void createTask(item.id)}><Plus size={16} /></IconButton></div>{expandedProjects[item.id] !== false && <div className="project-sessions">{visibleTasks.filter(task => task.projectId === item.id).map(task => <button key={task.id} aria-label={`Open session ${task.title}`} className={`project-session ${selectedTask === task.id && view === 'sessions' ? 'selected' : ''}`} onClick={() => chooseTask(task)}><CompactStatus task={task} /><span className="project-session-title">{task.title}</span>{isUnread(task) && <span className="session-unread" aria-hidden="true" />}</button>)}{!visibleTasks.some(task => task.projectId === item.id) && <p className="sidebar-muted">No sessions</p>}</div>}</div>)}
        {state && state.projects.length === 0 && <button className="add-project-prompt" onClick={() => openView('projects')}><FolderPlus size={15} />Add a project to begin</button>}
      </div>
      <button className="sidebar-foot" onClick={() => openView('hosts')}><Cloud size={19} /><div><strong>{currentHost?.online ? 'Host connected' : 'Host offline'}</strong><span>Manage computers in Settings</span></div></button>
    </aside>
    {sidebarOpen && <button className="mobile-scrim" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}
    {updateOpen && updateStatus?.latestVersion && <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-label="CIEL update available"><div className="modal-head"><h2>CIEL update available</h2><IconButton label="Close update" disabled={applyingUpdate} onClick={() => setUpdateOpen(false)}><X size={17} /></IconButton></div><p>Version {updateStatus.latestVersion} is ready for {currentHost?.name || 'this host'}.</p><p className="muted">{applyingUpdate ? 'Installing and restarting CIEL…' : updateStatus.busy ? 'Finish active or queued sessions before updating.' : 'Your sessions and settings stay on this computer.'}</p><div className="modal-actions"><button className="secondary-button" disabled={applyingUpdate} onClick={() => setUpdateOpen(false)}>Later</button><button className="primary-button" disabled={updateStatus.busy || applyingUpdate} onClick={() => void applyCielUpdate()}>{applyingUpdate ? <LoaderCircle size={16} className="spin" /> : <ArrowDownToLine size={16} />}Update and restart</button></div></section></div>}
    <div className="app-main">
      <header className="topbar">
        <IconButton label="Open menu" className="mobile-only" onClick={() => setSidebarOpen(true)}><Menu size={20} /></IconButton>
        <label className="top-select"><span>Host</span><select aria-label="Host" value={hostId} onChange={event => selectHost(event.target.value)}>{hosts.map(item => <option key={item.id} value={item.id}>{item.name}{item.local ? ' · this device' : ''}{!item.online ? ' · offline' : ''}</option>)}</select></label>
        <span className={`connection ${currentHost?.online ? 'online' : 'offline'}`}>{currentHost?.online ? <Wifi size={15} /> : <WifiOff size={15} />}{currentHost?.online ? 'Connected' : 'Offline'}</span>
        {view === 'sessions' && <><span className="top-project-context"><Folder size={15} />{project?.name || 'No session selected'}{selectedProject && selectedProject !== project?.id && <small>New in {state?.projects.find(item => item.id === selectedProject)?.name}</small>}</span>
          <button className="primary-button top-new" title={`New session in ${state?.projects.find(item => item.id === selectedProject)?.name || project?.name || 'a project'}`} disabled={busyAction === 'create-task'} onClick={() => void createTask(selectedProject || selected?.projectId || state?.projects[0]?.id)}><Plus size={17} />New session</button></>}
        {view !== 'sessions' && <span className="top-title">{({ projects: 'Projects', agents: 'Agents & accounts', library: 'Skills Library', hosts: 'Computers', settings: 'Settings' } as Record<string, string>)[view]}</span>}
      </header>
      {actionError && <div className="error-banner" role="alert"><CircleAlert size={17} />{actionError}<IconButton label="Dismiss error" onClick={() => setActionError('')}><X size={16} /></IconButton></div>}
      {loading ? <div className="workspace-placeholder"><LoaderCircle className="spin" /><h2>Loading {currentHost?.name || 'host'}…</h2></div> : error && !state ? <div className="workspace-placeholder"><WifiOff size={32} /><h2>{currentHost?.name || 'Host'} is unavailable</h2><p>{error}</p><button className="secondary-button" onClick={() => { setLoading(true); void refreshState(); }}>Retry</button></div> : state ? <>
        {view === 'sessions' && <div className="sessions-layout">
          <main className="conversation">{selected ? <>
            <div className="conversation-head"><div><div className="title-line"><h1>{selected.title}</h1><Status task={selected} /></div><p>{project?.path || 'Project path unavailable'}</p><div className="session-tags"><span><Folder size={14} />{project?.name || 'Project'}</span><EngineBadge engine={selected.engine} /><span><ShieldCheck size={14} />{selected.permission.replace('-', ' ')}</span></div></div><IconButton label="Show changes" className="changes-toggle" onClick={() => setChangesOpen(!changesOpen)}><FileDiff size={19} /></IconButton></div>
            <div className="conversation-scroll"><div className="messages">{detailLoading && !detail && <div className="inline-loading"><LoaderCircle className="spin" />Loading conversation…</div>}
              {detail && <ConversationTurns key={selected.id} detail={detail} busy={!!busyAction} onApprove={(id, choice) => act(`approve-${id}`, host => api.approve(host, id, choice))} />}
              {detail && detail.messages.length === 0 && <Empty icon={<Sparkles />} title="Ready for a new task">Describe what you want this agent to do in the project.</Empty>}
            </div></div>
            <div className="composer-wrap"><form className="composer" onSubmit={submit}><textarea aria-label="Message" placeholder={engineReady(engine) ? `Message ${engineNames[nextEngine]}…` : `Set up ${engineNames[nextEngine]} in Settings to run a session`} value={drafts[selected.id] || ''} onChange={event => setDrafts(previous => ({ ...previous, [selected.id]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} rows={2} /><div className="composer-bottom"><div className="composer-selects"><select aria-label="Agent" value={nextEngine} disabled={isBusy(selected)} onChange={event => { setNextEngine(event.target.value as EngineId); setNextModel(''); setNextEffort(''); }}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="opencode">OpenCode</option></select><ModelSelect engine={engine} value={nextModel} onChange={setNextModel} disabled={isBusy(selected)} /><select aria-label="Permission" value={nextPermission} disabled={isBusy(selected)} onChange={event => setNextPermission(event.target.value as PermissionMode)}>{(['full-access', 'ask', 'read-only'] as PermissionMode[]).filter(mode => !engine || engine.capabilities.permissions.includes(mode)).map(mode => <option key={mode} value={mode}>{mode === 'full-access' ? 'Full access' : mode === 'ask' ? 'Ask first' : 'Read only'}</option>)}</select>{models.find(model => model.id === nextModel)?.efforts?.length ? <select aria-label="Reasoning effort" value={nextEffort} onChange={event => setNextEffort(event.target.value)}><option value="">Default effort</option>{models.find(model => model.id === nextModel)!.efforts!.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select> : null}</div><div className="composer-buttons">{run && (run.status === 'running' || run.status === 'queued' || run.status === 'waiting') && <IconButton label="Interrupt run" onClick={() => void act('interrupt', host => api.interrupt(host, run.id))}><Square size={17} /></IconButton>}<button type="submit" className="send-button" disabled={!drafts[selected.id]?.trim() || !!busyAction || !engineReady(engine) || selected.status === 'running' || selected.status === 'waiting'} aria-label="Send message"><Send size={19} /></button></div></div></form>{!engineReady(engine) && <button className="setup-hint" onClick={() => openView('agents')}><CircleAlert size={14} />{engineNames[nextEngine]} needs setup. Settings → Agents & accounts <ArrowRight size={14} /></button>}</div>
          </> : <Empty icon={<MessageSquare />} title="Ready for a session">Choose a session in the sidebar or create a new one.</Empty>}</main>
          <aside className={`changes-panel ${changesOpen ? 'open' : ''}`}><div className="pane-heading"><h2>Changes this turn</h2><IconButton label="Close changes" className="changes-close" onClick={() => setChangesOpen(false)}><X size={18} /></IconButton></div><TurnInspector key={selectedTask} detail={detail} /></aside>
        </div>}
        {view === 'library' && <LibraryBrowser items={state.library} onAdd={item => act('add-library', host => api.addLibrary(host, item))} onUpdate={(id, item) => act('update-library', host => api.updateLibrary(host, id, item))} onDelete={id => act('delete-library', host => api.deleteLibrary(host, id))} onExport={() => act('export-library', async host => { const data = await api.exportLibrary(host); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `ciel-library-${host}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })} onImport={data => act('import-library', host => api.importLibrary(host, data))} busy={!!busyAction} />}
        {['projects', 'agents', 'hosts', 'settings'].includes(view) && <div className="settings-layout"><nav className="settings-nav" aria-label="Settings sections"><h2>Settings</h2>{([['projects', Folder, 'Projects'], ['agents', Bot, 'Agents & accounts'], ['hosts', Monitor, 'Computers'], ['settings', Settings2, 'Preferences']] as const).map(([id, Icon, label]) => <button key={id} className={view === id ? 'selected' : ''} onClick={() => setView(id)}><Icon size={16} />{label}</button>)}</nav><div className="settings-body">
          {view === 'projects' && <ProjectsPage projects={state.projects} tasks={state.tasks} previews={state.previews || []} remote={!currentHost?.local} onAdd={(name, path) => act('add-project', host => api.createProject(host, name, path))} onChoose={chooseProject} onPreview={(input) => act('create-preview', host => api.createPreview(host, input))} onStopPreview={id => act('stop-preview', host => api.stopPreview(host, id))} busy={!!busyAction} />}
          {view === 'agents' && <AgentsPage hostId={hostId} engines={engines} runtimes={runtimes} setEngines={setEngines} setRuntimes={setRuntimes} act={act} busy={!!busyAction} />}
          {view === 'hosts' && <HostsPage hostId={hostId} hosts={hosts} network={network} setNetwork={setNetwork} refreshHosts={refreshHosts} selectHost={selectHost} act={act} busy={!!busyAction} />}
          {view === 'settings' && <SettingsPage settings={state.settings} updateDirectory={updateStatus?.sourceDirectory} onUpdate={patch => act('settings', host => api.updateSettings(host, patch), () => { void api.updateStatus(hostId).then(setUpdateStatus).catch(() => undefined); })} notificationEnabled={notificationEnabled} setNotificationEnabled={setNotificationEnabled} busy={!!busyAction} />}
        </div></div>}
      </> : null}
    </div>
  </div>;
}

function MessageBubble({ message, engine, hostId, onOpenImage }: { message: Message; engine: EngineId; hostId: string; onOpenImage: (id: string) => void }) {
  return <div className={`message ${message.role}`}><div className="avatar">{message.role === 'user' ? 'Y' : message.role === 'assistant' ? <Bot size={18} /> : <Activity size={16} />}</div><div className="message-body"><div className="message-meta"><strong>{message.role === 'user' ? 'You' : message.role === 'assistant' ? engineNames[message.engine || engine] : 'CIEL'}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>{message.text && <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown></div>}{message.images?.map(image => {
    const url=`${hostPath(hostId)}/tasks/${encodeURIComponent(message.taskId)}/images/${encodeURIComponent(image.id)}`;
    return <button type="button" className="message-image" key={image.id} onClick={() => onOpenImage(image.id)} aria-label="View generated image"><img src={url} alt="Generated image" loading="lazy" /></button>;
  })}</div></div>;
}
function ConversationTurns({ detail, busy, onApprove }: { detail: TaskDetail; busy: boolean; onApprove: (id: string, choice: string) => Promise<void> }) {
  const [openImageId, setOpenImageId] = useState<string | null>(null);
  const images: ViewerImage[] = detail.messages.flatMap(message => (message.images || []).map(image => ({ id: image.id, url: `${hostPath(detail.task.hostId)}/tasks/${encodeURIComponent(message.taskId)}/images/${encodeURIComponent(image.id)}`, label: 'Generated image' })));
  const imageIndex = images.findIndex(image => image.id === openImageId);
  const knownRuns = new Set(detail.runs.map(run => run.id));
  return <>
    {detail.messages.filter(message => !message.runId || !knownRuns.has(message.runId)).map(message => <MessageBubble key={message.id} message={message} engine={detail.task.engine} hostId={detail.task.hostId} onOpenImage={setOpenImageId} />)}
    {detail.runs.map((turn, index) => {
      const messages = detail.messages.filter(message => message.runId === turn.id);
      return <section key={turn.id} className="conversation-turn" aria-label={`Turn ${index + 1}`}>
        {messages.map(message => <MessageBubble key={message.id} message={message} engine={turn.engine} hostId={detail.task.hostId} onOpenImage={setOpenImageId} />)}
        {turn.status === 'running' && !messages.some(message => message.role === 'assistant') && <StreamingMessage detail={detail} run={turn} engine={turn.engine} />}
        {detail.approvals.filter(approval => approval.runId === turn.id && approval.status === 'pending').map(approval => <div key={approval.id} className="approval-card"><div><ShieldCheck size={18} /><strong>{approval.title}</strong></div><p>{approval.description}</p><div className="approval-actions">{approval.choices.map(choice => <button key={choice} className="secondary-button" disabled={busy} onClick={() => void onApprove(approval.id, choice)}>{choice}</button>)}</div></div>)}
        <RunActivity events={detail.events} run={turn} turnNumber={index + 1} />
      </section>;
    })}
    {imageIndex >= 0 && <ImageViewer images={images} index={imageIndex} onIndex={next => setOpenImageId(images[next]!.id)} onClose={() => setOpenImageId(null)} />}
  </>;
}

function ModelSelect({ engine, value, onChange, disabled }: { engine?: EngineStatus; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  if (!engine?.capabilities.modelDiscovery || !engine.models.length) return <input className="model-input" aria-label="Model" placeholder="Native default model" value={value} disabled={disabled} onChange={event => onChange(event.target.value)} />;
  return <select aria-label="Model" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}><option value="">Default model</option>{engine.models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}</select>;
}
function StreamingMessage({ detail, run, engine }: { detail: TaskDetail; run?: Run; engine: EngineId }) {
  const text = detail.events.filter(event => event.runId === run?.id && (event.type === 'text.delta' || event.type === 'message.delta') && event.data.channel !== 'reasoning').map(event => String(event.data.text || event.data.delta || '')).join('');
  return <div className="message assistant"><div className="avatar"><Bot size={18} /></div><div className="message-body"><div className="message-meta"><strong>{engineNames[engine]}</strong><span className="streaming-label"><LoaderCircle size={13} className="spin" />Working</span></div>{text ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div> : <span className="typing"><i /><i /><i /></span>}</div></div>;
}
function TurnInspector({ detail }: { detail: TaskDetail | null }) {
  const [chosenRun, setChosenRun] = useState('');
  const turn = detail?.runs.find(item => item.id === chosenRun) || detail?.runs.at(-1);
  const changes = detail?.changes.find(item => item.runId === turn?.id);
  return <>
    {detail && detail.runs.length > 1 && <label className="turn-select">Turn<select aria-label="Changes turn" value={turn?.id || ''} onChange={event => setChosenRun(event.target.value)}>{detail.runs.map((item, index) => <option key={item.id} value={item.id}>Turn {index + 1} · {new Date(item.createdAt).toLocaleString()}</option>)}</select></label>}
    <div className="changes-list">{!changes || changes.files.length === 0 ? <Empty icon={<FileDiff />} title="No changes captured">Files changed during this turn will appear here.</Empty> : <><div className="change-count">{changes.files.length} {changes.files.length === 1 ? 'file' : 'files'} changed</div>{changes.warning && <p className="warning-note">{changes.warning}</p>}{changes.files.map(file => <details key={file.path} className="change-file"><summary><FileCode size={15} /><span>{file.path}</span><em className={`change-kind ${file.kind}`}>{file.kind}</em></summary><div className="change-meta">+{file.additions} / −{file.deletions}{file.binary ? ' · binary' : ''}{file.truncated ? ' · truncated' : ''}</div>{file.patch && <pre>{file.patch}</pre>}</details>)}</>}</div>
    <div className="panel-divider" /><h3><Activity size={17} />Activity this turn</h3><RunActivity key={turn?.id || 'empty'} events={detail?.events || []} run={turn} compact />
  </>;
}

function ProjectsPage({ projects, tasks, previews, remote, onAdd, onChoose, onPreview, onStopPreview, busy }: { projects: Project[]; tasks: Task[]; previews: Preview[]; remote: boolean; onAdd: (name: string, path: string) => void; onChoose: (project: Project) => void; onPreview: (input: { projectId: string; name: string; port: number; command?: string; remote: boolean }) => void; onStopPreview: (id: string) => void; busy: boolean }) {
  const [name, setName] = useState(''); const [path, setPath] = useState('');
  const [previewProject, setPreviewProject] = useState(projects[0]?.id || ''); const [previewName, setPreviewName] = useState('Preview'); const [port, setPort] = useState('5173'); const [command, setCommand] = useState('');
  return <div className="page"><div className="page-heading"><div><p className="eyebrow">WORKSPACE</p><h1>Projects</h1><p>Existing folders and previews on this host.</p></div><Folder size={28} /></div><div className="page-grid"><div className="side-stack"><section className="surface"><h2>Your projects</h2>{projects.length ? <div className="resource-list">{projects.map(project => <button key={project.id} className="resource-row" onClick={() => onChoose(project)}><span className="resource-icon"><Folder size={19} /></span><span className="resource-copy"><strong>{project.name}</strong><small>{project.path}</small></span><span className="resource-aside">{tasks.filter(task => task.projectId === project.id && !task.archived).length} sessions <ArrowRight size={16} /></span></button>)}</div> : <Empty icon={<Folder />} title="No projects yet">Add a folder from this host to begin.</Empty>}</section><section className="surface"><h2><Code2 size={18} />Previews</h2>{previews.length ? <div className="resource-list">{previews.map(preview => { const safeUrl = preview.url && (!remote || !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(preview.url)) ? preview.url : ''; return <div key={preview.id} className="resource-row"><span className="resource-icon"><Code2 size={18} /></span><span className="resource-copy"><strong>{preview.name}</strong><small>{projects.find(item => item.id === preview.projectId)?.name || 'Project'} · port {preview.port} · {preview.status}</small>{preview.error && <small className="warning-note">{preview.error}</small>}</span>{safeUrl && ['running', 'registered'].includes(preview.status) && <a className="secondary-button" href={safeUrl} target="_blank" rel="noopener noreferrer">Open <ExternalLink size={14} /></a>}{['running', 'registered'].includes(preview.status) && <IconButton label={`Stop ${preview.name}`} onClick={() => onStopPreview(preview.id)}><Square size={15} /></IconButton>}</div>; })}</div> : <p className="muted">No previews registered.</p>}</section></div><div className="side-stack"><section className="surface side-form"><h2><FolderPlus size={19} />Add project</h2><p>Point CIEL to an existing folder on the selected host.</p><form onSubmit={event => { event.preventDefault(); if (name.trim() && path.trim()) { onAdd(name.trim(), path.trim()); setName(''); setPath(''); } }}><label>Name<input required value={name} onChange={event => setName(event.target.value)} placeholder="My project" /></label><label>Folder path<input required value={path} onChange={event => setPath(event.target.value)} placeholder="/home/user/projects/my-project" /></label><button className="primary-button" disabled={busy || !name.trim() || !path.trim()}><Plus size={16} />Add project</button></form></section><section className="surface side-form"><h2><Code2 size={18} />Start preview</h2><p>Run a dev server in a project folder, or register an existing server by leaving command blank.</p><form onSubmit={event => { event.preventDefault(); const number = Number(port); if (previewProject && number >= 1 && number <= 65535) onPreview({ projectId: previewProject, name: previewName.trim() || 'Preview', port: number, command: command.trim() || undefined, remote }); }}><label>Project<select value={previewProject} onChange={event => setPreviewProject(event.target.value)}>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Name<input value={previewName} onChange={event => setPreviewName(event.target.value)} /></label><label>Port<input type="number" min="1" max="65535" value={port} onChange={event => setPort(event.target.value)} /></label><label>Command (optional)<input value={command} onChange={event => setCommand(event.target.value)} placeholder="pnpm dev" /></label><button className="primary-button" disabled={busy || !previewProject || !port}>Start preview</button></form></section></div></div></div>;
}

function AgentsPage({ hostId, engines, runtimes, setEngines, setRuntimes, act, busy }: { hostId: string; engines: EngineStatus[]; runtimes: RuntimeState[]; setEngines: (value: EngineStatus[]) => void; setRuntimes: (value: RuntimeState[]) => void; act: (key: string, operation: (host: string) => Promise<unknown>, after?: () => void) => Promise<void>; busy: boolean }) {
  const [flows, setFlows] = useState<Partial<Record<EngineId, AuthFlow>>>({});
  const [key, setKey] = useState('');
  const refresh = async () => { const [nextEngines, nextRuntimes] = await Promise.all([api.engines(hostId), api.runtimes(hostId)]); setEngines(nextEngines); setRuntimes(nextRuntimes); };
  const login = (id: EngineId) => void act(`login-${id}`, async host => { const flow = await api.login(host, id); setFlows(previous => ({ ...previous, [id]: flow })); }, () => { void refresh(); });
  return <div className="page"><div className="page-heading"><div><p className="eyebrow">NATIVE AGENTS</p><h1>Agents &amp; accounts</h1><p>Installed agents and account status on this host.</p></div><button className="secondary-button" onClick={() => void refresh()}><RefreshCw size={16} />Refresh</button></div><div className="agent-grid">{(['codex', 'claude', 'opencode'] as EngineId[]).map(id => { const engine = engines.find(item => item.id === id); const runtime = runtimes.find(item => item.engine === id); return <section key={id} className="surface agent-card"><div className="agent-head"><div className={`agent-icon ${id}`}><Bot size={25} /></div><div><h2>{engineNames[id]}</h2><p>{engine?.authMode || 'Native agent'}</p></div><span className={`pill ${engineReady(engine) ? 'success' : engine?.installed ? 'warning' : 'neutral'}`}>{engineReady(engine) ? 'Ready' : engine?.installed ? 'Sign in needed' : 'Setup needed'}</span></div><div className="agent-facts"><div><span>Runtime</span><strong>{runtime?.state === 'installing' ? 'Installing…' : engine?.installed ? `Installed${engine.version ? ` · ${engine.version}` : ''}` : runtime?.message || 'Not installed'}</strong></div><div><span>Account</span><strong>{engine?.authenticated ? engine.accountLabel || 'Authenticated' : engine?.error || 'Not connected'}</strong></div><div><span>Models</span><strong>{engine?.models.length ? `${engine.models.length} available · ${engine.models.slice(0, 3).map(model => model.name).join(', ')}${engine.models.length > 3 ? '…' : ''}` : engine?.capabilities.modelDiscovery ? 'Detecting models…' : 'Native default or custom'}</strong></div></div>{flows[id] && <div className="flow-note"><CircleHelp size={17} /><span>{flows[id]!.message}{flows[id]!.url?.startsWith('https://') && <><br /><a href={flows[id]!.url} target="_blank" rel="noopener noreferrer">Open sign-in page <ExternalLink size={13} /></a></>}{flows[id]!.userCode && <><br />Code: <code>{flows[id]!.userCode}</code></>}</span></div>}{runtime?.message && runtime.state === 'failed' && <p className="warning-note">{runtime.message}</p>}<div className="agent-actions">{(!engine?.installed || (runtime?.latestVersion && runtime.latestVersion !== runtime.installedVersion)) && <button className="primary-button" disabled={busy || runtime?.state === 'installing'} onClick={() => void act(`install-${id}`, host => api.installRuntime(host, id), () => { void refresh(); })}><ArrowDownToLine size={16} />{runtime?.state === 'installing' ? 'Installing…' : engine?.installed ? 'Update agent' : 'Install agent'}</button>}{engine?.installed && !engine.authenticated && <button className="primary-button" disabled={busy} onClick={() => login(id)}><KeyRound size={16} />Sign in</button>}{engine?.installed && <button className="secondary-button" disabled={busy} onClick={() => void act(`check-${id}`, host => api.checkRuntime(host, id), () => { void refresh(); })}><RefreshCw size={15} />Check updates</button>}</div>{id === 'opencode' && <form className="key-form" onSubmit={event => { event.preventDefault(); if (key) void act('key', host => api.setOpenRouterKey(host, key), () => { setKey(''); void refresh(); }); }}><label>OpenRouter API key<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder="Enter key on this host" /></label><button className="secondary-button" disabled={!key || busy}>Save key</button></form>}</section>; })}</div></div>;
}

type LibraryProps = { items: LibraryItem[]; onAdd: (item: Partial<LibraryItem>) => void; onUpdate: (id: string, item: Partial<LibraryItem>) => void; onDelete: (id: string) => void; onExport: () => void; onImport: (data: unknown) => void; busy: boolean };
function LibraryBrowser({ items, onAdd, onUpdate, onDelete, onExport, onImport, busy }: LibraryProps) {
  const [selectedId, setSelectedId] = useState('');
  const [editing, setEditing] = useState<LibraryItem | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [content, setContent] = useState('');
  const [kind, setKind] = useState<LibraryItem['kind']>('skill');
  const [engines, setEngines] = useState<EngineId[]>(['codex', 'claude', 'opencode']);
  const selected = items.find(item => item.id === selectedId) || items[0];
  const edit = (item?: LibraryItem) => {
    setEditing(item || null); setName(item?.name || ''); setDescription(item?.description || '');
    setContent(item?.content || ''); setKind(item?.kind || 'skill'); setEngines(item?.engines || ['codex', 'claude', 'opencode']); setEditorOpen(true);
  };
  const save = (event: FormEvent) => {
    event.preventDefault(); const value = { name: name.trim(), description: description.trim(), content, kind, engines, enabled: editing?.enabled ?? true };
    if (editing) onUpdate(editing.id, value); else onAdd(value);
    setEditorOpen(false);
  };
  const importFile = async (file?: File) => { if (!file) return; try { onImport(JSON.parse(await file.text())); } catch { alert('Invalid library JSON file'); } };
  let readableContent = selected?.content || '';
  if (selected?.kind === 'mcp') { try { readableContent = JSON.stringify(JSON.parse(readableContent), null, 2); } catch { /* Display the original content. */ } }
  return <div className="page library-page">
    <div className="page-heading"><div><p className="eyebrow">HOST LIBRARY</p><h1>Skills Library</h1><p>Read and manage items saved for agents on this host.</p></div><div className="page-actions"><button className="secondary-button" onClick={onExport}><ArrowDownToLine size={16} />Export</button><label className="secondary-button file-label"><Plus size={16} />Import<input type="file" accept="application/json,.json" onChange={event => void importFile(event.target.files?.[0])} /></label><button className="primary-button" onClick={() => edit()}><Plus size={16} />New item</button></div></div>
    <div className="library-layout"><section className="surface library-index"><h2>Saved items</h2>{items.length ? <div className="library-rows">{items.map(item => <div key={item.id} className={`library-row ${selected?.id === item.id ? 'selected' : ''}`}><button aria-label={`Read ${item.name}`} onClick={() => setSelectedId(item.id)}><BookOpen size={18} /><span><strong>{item.name}</strong><small>{item.kind} · {item.description || 'No description'}</small></span></button><IconButton label={`Edit ${item.name}`} onClick={() => edit(item)}><Pencil size={16} /></IconButton></div>)}</div> : <Empty icon={<BookOpen />} title="Your library is empty">Save a skill, instruction, memory, or MCP connection to share it with selected agents.</Empty>}</section>
      <article className="surface library-reader">{selected ? <><div className="library-reader-head"><div><span className="eyebrow">{selected.kind.toUpperCase()}</span><h2>{selected.name}</h2><p>{selected.description || 'No description'}</p></div><div className="page-actions"><span className={`pill ${selected.enabled ? 'success' : 'neutral'}`}>{selected.enabled ? 'Enabled' : 'Disabled'}</span><button className="secondary-button" onClick={() => edit(selected)}><Pencil size={15} />Edit</button><IconButton label={`Delete ${selected.name}`} onClick={() => { if (confirm(`Delete ${selected.name}?`)) { onDelete(selected.id); setSelectedId(''); } }}><Trash2 size={16} /></IconButton></div></div><div className="library-engines">For {selected.engines.map(id => engineNames[id]).join(', ') || 'no agents'}</div>{selected.kind === 'mcp' ? <pre className="library-json">{readableContent}</pre> : <div className="markdown library-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{readableContent}</ReactMarkdown></div>}</> : <Empty icon={<BookOpen />} title="Select an item">Choose a library item to read its full content.</Empty>}</article></div>
    {editorOpen && <div className="modal-backdrop" onClick={() => setEditorOpen(false)}><div className="modal wide" role="dialog" aria-modal="true" onClick={event => event.stopPropagation()}><div className="modal-head"><h2>{editing ? 'Edit library item' : 'New library item'}</h2><IconButton label="Close" onClick={() => setEditorOpen(false)}><X size={19} /></IconButton></div><form onSubmit={save}><label>Name<input required value={name} onChange={event => setName(event.target.value)} /></label><label>Description<input value={description} onChange={event => setDescription(event.target.value)} /></label><label>Kind<select value={kind} onChange={event => setKind(event.target.value as LibraryItem['kind'])}><option value="skill">Skill</option><option value="instruction">Instruction</option><option value="memory">Memory</option><option value="mcp">MCP</option></select></label><label>Content<textarea required rows={9} value={content} onChange={event => setContent(event.target.value)} /></label><fieldset><legend>Agents</legend>{(['codex', 'claude', 'opencode'] as EngineId[]).map(id => <label key={id} className="check-label"><input type="checkbox" checked={engines.includes(id)} onChange={event => setEngines(current => event.target.checked ? [...current, id] : current.filter(item => item !== id))} />{engineNames[id]}</label>)}</fieldset><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setEditorOpen(false)}>Cancel</button><button className="primary-button" disabled={busy || !name.trim() || !content || !engines.length}>Save item</button></div></form></div></div>}
  </div>;
}

function HostsPage({ hostId, hosts, network, setNetwork, refreshHosts, selectHost, act, busy }: { hostId: string; hosts: HostConnection[]; network: { url?: string; port?: number }; setNetwork: (value: { url?: string; port?: number }) => void; refreshHosts: () => Promise<HostConnection[]>; selectHost: (id: string) => void; act: (key: string, operation: (host: string) => Promise<unknown>, after?: () => void) => Promise<void>; busy: boolean }) {
  const [url, setUrl] = useState(''); const [code, setCode] = useState(''); const [pairCode, setPairCode] = useState<{ code: string; expiresAt: string } | null>(null);
  return <div className="page"><div className="page-heading"><div><p className="eyebrow">COMPUTERS</p><h1>Computers</h1><p>Each host keeps its own files, agents, and sessions.</p></div><Monitor size={29} /></div><div className="page-grid"><section className="surface"><h2>Connected hosts</h2><div className="resource-list">{hosts.map(item => <div key={item.id} className="resource-row"><span className="resource-icon"><Laptop size={19} /></span><span className="resource-copy"><strong>{item.name} {item.local && <span className="muted">· this device</span>}</strong><small>{item.platform} · {item.online ? 'Online' : 'Offline'}{item.url ? ` · ${item.url}` : ''}</small></span><span className={`presence ${item.online ? 'online' : 'offline'}`} />{item.id !== hostId && <button className="secondary-button" onClick={() => selectHost(item.id)}>Open</button>}{!item.local && <IconButton label={`Forget ${item.name}`} onClick={() => { if (confirm(`Forget ${item.name}?`)) void act('forget-host', () => api.forgetHost(item.id), () => { void refreshHosts(); }); }}><Trash2 size={15} /></IconButton>}</div>)}</div></section><div className="side-stack"><section className="surface side-form"><h2><Wifi size={18} />This host's private address</h2><p>{network.url || 'Private remote access is not enabled yet.'}</p><button className="secondary-button" disabled={busy} onClick={() => void act('network', async host => { setNetwork(await api.enableNetwork(host)); })}><Wifi size={16} />Enable Tailscale access</button></section><section className="surface side-form"><h2><KeyRound size={18} />Pair a computer</h2><p>Generate a code on the computer receiving a connection, then enter its address and code here.</p><button className="secondary-button" onClick={() => void act('pair-code', async () => { setPairCode(await api.pairCode()); })}>Generate code for this host</button>{pairCode && <div className="pair-code"><strong>{pairCode.code}</strong><small>Expires {new Date(pairCode.expiresAt).toLocaleTimeString()}</small></div>}<form onSubmit={event => { event.preventDefault(); void act('pair-host', async () => { await api.pairHost(url, code); }, () => { setUrl(''); setCode(''); void refreshHosts(); }); }}><label>Other host address<input required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://computer.tailnet.ts.net" /></label><label>Pairing code<input required value={code} onChange={event => setCode(event.target.value)} placeholder="Code from other computer" /></label><button className="primary-button" disabled={busy || !url || !code}>Pair host</button></form></section></div></div></div>;
}

function SettingsPage({ settings, updateDirectory, onUpdate, notificationEnabled, setNotificationEnabled, busy }: { settings: HostState['settings']; updateDirectory?: string; onUpdate: (patch: Partial<HostState['settings']>) => void; notificationEnabled: boolean; setNotificationEnabled: (value: boolean) => void; busy: boolean }) {
  const toggleNotifications = async (enabled: boolean) => { if (enabled && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission(); setNotificationEnabled(enabled && 'Notification' in window && Notification.permission === 'granted'); onUpdate({ notifications: enabled }); };
  return <div className="page"><div className="page-heading"><div><p className="eyebrow">HOST PREFERENCES</p><h1>Settings</h1><p>Settings apply to the selected host.</p></div><Settings2 size={28} /></div><section className="surface settings-surface"><div className="setting-row"><div><h3>Host name</h3><p>Shown in the host picker and paired computers.</p></div><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); onUpdate({ name: String(data.get('name') || '') }); }}><input name="name" defaultValue={settings.name} key={settings.name} aria-label="Host name" /><button className="secondary-button" disabled={busy}>Save</button></form></div><div className="setting-row"><div><h3>Default permissions</h3><p>Initial permission mode for new tasks.</p></div><select aria-label="Default permissions" value={settings.defaultPermission} onChange={event => onUpdate({ defaultPermission: event.target.value as PermissionMode })}><option value="full-access">Full access</option><option value="ask">Ask first</option><option value="read-only">Read only</option></select></div><div className="setting-row"><div><h3>Browser notifications</h3><p>Alerts for new results from the selected host while this app is open.</p></div><label className="switch"><input type="checkbox" checked={settings.notifications && notificationEnabled} onChange={event => void toggleNotifications(event.target.checked)} /><span /></label></div><div className="setting-row"><div><h3>Local CIEL releases</h3><p>Folder to check for newer Linux tarball builds on this host.</p></div><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); onUpdate({ updateDirectory: String(data.get('updateDirectory') || '') }); }}><input name="updateDirectory" defaultValue={settings.updateDirectory || updateDirectory || ''} key={settings.updateDirectory || updateDirectory || ''} aria-label="Local CIEL releases folder" /><button className="secondary-button" disabled={busy}>Save</button></form></div><div className="setting-row"><div><h3>Agent runtime updates</h3><p>Update Codex, Claude Code, and OpenCode while their sessions are idle.</p></div><label className="switch"><input type="checkbox" checked={settings.autoUpdate} onChange={event => onUpdate({ autoUpdate: event.target.checked })} /><span /></label></div></section></div>;
}
