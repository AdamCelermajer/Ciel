import { useId, useMemo, useState } from 'react';
import { Check, ChevronDown, CircleAlert, LoaderCircle, Square } from 'lucide-react';
import type { HostEvent, Run } from '@ciel/contracts';
import { activityDuration, activityForRun, type ActivityItem } from './activity';

const engines = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' };
const statuses = { running: 'Running', completed: 'Completed', failed: 'Failed', attention: 'Needs input', stopped: 'Stopped' };
function Indicator({ item }: { item: ActivityItem }) {
  const Icon = item.status === 'running' ? LoaderCircle : item.status === 'completed' ? Check : item.status === 'stopped' ? Square : CircleAlert;
  return <Icon size={14} className={`tool-status ${item.status} ${item.status === 'running' ? 'spin' : ''}`} aria-label={statuses[item.status]} />;
}
function ToolDetail({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  const limit = 12000;
  return <div className="tool-detail"><h4>{label}</h4><pre>{value.length > limit ? value.slice(0, limit) + '\n…Display truncated' : value}</pre></div>;
}
export function RunActivity({ events, run, turnNumber, compact = false }: { events: HostEvent[]; run?: Run; turnNumber?: number; compact?: boolean }) {
  const region = useId();
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const items = useMemo(() => run ? activityForRun(events, run) : [], [events, run]);
  if (!run || !items.length) return compact ? <p className="activity-empty">No tools used in this turn.</p> : null;
  const needsAttention = ['failed', 'interrupted', 'waiting'].includes(run.status);
  const open = compact || (expanded ?? (['running', 'waiting'].includes(run.status) || needsAttention));
  const count = items.filter(item => item.kind === 'tool').length;
  const summary = count ? `${count} ${count === 1 ? 'tool call' : 'tool calls'}` : 'Activity';
  return <section className={`run-activity ${compact ? 'compact' : ''}`} aria-label={compact ? 'Selected turn activity' : `Turn ${turnNumber ?? ''} activity`.trim()}>
    {!compact && <button className="activity-summary" aria-expanded={open} aria-controls={region} onClick={() => setExpanded(!open)}>
      <ChevronDown size={15} className={open ? '' : 'collapsed'} /><span>{summary}</span><span className="activity-engine">{engines[run.engine]}</span>
      <span className={`activity-result ${needsAttention ? 'attention' : ''}`}>{needsAttention ? 'Needs attention' : run.status === 'completed' ? 'Finished' : run.status === 'cancelled' || run.status === 'interrupted' ? 'Stopped' : 'Working'}</span>
    </button>}
    <div id={region} hidden={!open} className="tool-list">{items.map(item => <details key={item.id} className="tool-entry">
      <summary><Indicator item={item} /><span className="tool-title">{item.label}</span><span className="tool-duration">{activityDuration(item)}</span><ChevronDown size={12} /></summary>
      <div className="tool-content"><p className="tool-identity">{engines[item.engine]}{item.nativeName && <> · <code>{item.nativeName}</code></>} · {statuses[item.status]}</p>
        {item.description && <p className="tool-description">{item.description}</p>}
        <ToolDetail label="Input" value={item.input} /><ToolDetail label="Result" value={item.output} />
      </div>
    </details>)}</div>
  </section>;
}
