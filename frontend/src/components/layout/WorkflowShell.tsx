import { useEffect, useState, type ElementType, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { WorkflowDownloadBanner } from '../ui/WorkflowDownloadBanner';
import { usePersistentState } from '../../hooks/usePersistentState';
import { useComfyExecution } from '../../contexts/ComfyExecutionContext';

interface WorkflowShellProps {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  icon?: ElementType;
  preview?: ReactNode;
  children: ReactNode;
  output: ReactNode;
  isGenerating?: boolean;
  canGenerate?: boolean;
  leftClassName?: string;
  outputClassName?: string;
  hideOutputPane?: boolean;
  workflowId?: string;
}

export const WorkflowShell = ({
  title,
  eyebrow,
  description,
  icon: Icon,
  preview,
  children,
  output,
  leftClassName = '',
  outputClassName = '',
  hideOutputPane = false,
  workflowId,
}: WorkflowShellProps) => {
  // Remembered per workflow — the strip reserves up to 42vh, so collapsing it is
  // a per-page preference the user shouldn't have to redo on every visit.
  // Collapsed until there is something to show. Opening by default spent the
  // top of every page on an empty output pane, which is what pushed the
  // controls below the fold before a single generation existed. It opens
  // itself the moment a run produces output, so nothing is hidden that the
  // user actually made.
  const [outputCollapsed, setOutputCollapsed] = usePersistentState(
    `workflow_output_collapsed_${workflowId ?? 'default'}`,
    true,
  );

  // Deliberately not persisted. A run reveals the pane so the result is never
  // hidden, but that reveal must not become the saved preference - otherwise
  // one generation puts every future visit back to opening on an empty pane,
  // which is the thing being fixed.
  const { state } = useComfyExecution();
  const [revealedByRun, setRevealedByRun] = useState(false);
  useEffect(() => {
    if (state === 'executing') setRevealedByRun(true);
  }, [state]);
  const collapsed = outputCollapsed && !revealedByRun;

  return (
    <div className={`workflow-shell ${hideOutputPane ? 'workflow-shell-no-output' : ''}`.trim()}>
      {!hideOutputPane && (
        <section
          className={`workflow-output-strip ${collapsed ? 'workflow-output-strip-collapsed' : ''} ${outputClassName}`.trim()}
        >
          <button
            type="button"
            onClick={() => {
              // Hiding it by hand also clears the run's reveal, or the button
              // would appear to do nothing while a generation is in flight.
              setRevealedByRun(false);
              setOutputCollapsed(collapsed ? false : true);
            }}
            aria-expanded={!collapsed}
            title={collapsed ? 'Show output' : 'Hide output'}
            className="workflow-output-toggle"
          >
            {collapsed ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
            <span>{collapsed ? 'Show output' : 'Hide output'}</span>
          </button>
          {!collapsed && output}
        </section>
      )}

      <section className={`workflow-control-pane ${leftClassName}`.trim()}>
        {/*
          Which workflow this is, on the page rather than only in the top bar.
          These props were accepted and then dropped on the floor, so every
          generate page looked identical - someone ran Image to Video believing
          they were in Text to Image, and nothing on screen contradicted them.
        */}
        {title && (
          <header className="workflow-shell-head">
            {eyebrow && <div className="fedda-kicker">{eyebrow}</div>}
            <h2>
              {Icon && <Icon className="h-4 w-4 text-white/45" />}
              {title}
            </h2>
            {description && <p>{description}</p>}
          </header>
        )}

        {preview ? <div className="workflow-shell-preview">{preview}</div> : null}

        {/*
          Wrapped so the grid has one stable child to place. The banner itself
          returns a different root per state - downloading, missing, ready - and
          none of them share a class to hook onto.
        */}
        {workflowId && (
          <div className="workflow-download-banner">
            <WorkflowDownloadBanner workflowId={workflowId} />
          </div>
        )}

        <div className="workflow-scroll">
          {children}
        </div>
      </section>
    </div>
  );
};

interface WorkflowSectionProps {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Anchor name for a Tour step. */
  dataTour?: string;
}

export const WorkflowSection = ({ title, actions, children, className = '', dataTour }: WorkflowSectionProps) => {
  return (
    // data-tour is what Tour anchors on. An attribute rather than a class or a
    // DOM path, so restyling a section cannot quietly break a walkthrough.
    <section className={`workflow-section ${className}`.trim()} data-tour={dataTour}>
      {(title || actions) && (
        <div className="workflow-section-header">
          {title ? <div className="workflow-section-title">{title}</div> : <span />}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
};
