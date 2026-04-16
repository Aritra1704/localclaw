import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

const tokenKey = 'localclaw.controlToken';
const controlApiOrigin = 'http://127.0.0.1:4173';
const navItems = [
  ['chat', 'Chat'],
  ['tasks', 'Tasks'],
  ['approvals', 'Approvals'],
  ['projects', 'Projects'],
  ['skills', 'Skills'],
  ['diagnostics', 'Diagnostics'],
];
const dashboardLoaders = [
  {
    key: 'status',
    load: () => api('/v1/status'),
    apply: (nextState, data) => {
      nextState.status = data;
    },
  },
  {
    key: 'tasks',
    load: () => api('/v1/tasks?limit=50'),
    apply: (nextState, data) => {
      nextState.tasks = data;
    },
  },
  {
    key: 'approvals',
    load: () => api('/v1/approvals?limit=50'),
    apply: (nextState, data) => {
      nextState.approvals = data;
    },
  },
  {
    key: 'skills',
    load: () => api('/v1/skills?limit=50'),
    apply: (nextState, data) => {
      nextState.skills = data;
    },
  },
  {
    key: 'actors',
    load: () => api('/v1/chat/actors'),
    apply: (nextState, data) => {
      nextState.actors = data;
    },
  },
  {
    key: 'sessions',
    load: () => api('/v1/chat/sessions?limit=20'),
    apply: (nextState, data) => {
      nextState.sessions = data;
    },
  },
  {
    key: 'projects',
    load: () => api('/v1/projects'),
    apply: (nextState, data) => {
      nextState.projects = data.projects || [];
      nextState.allowedRoots = data.allowedRoots || [];
    },
  },
];
const liveTaskStatuses = new Set(['pending', 'in_progress', 'verifying', 'waiting_approval']);

function formatDuration(duration) {
  if (!duration || Number.isNaN(Number(duration))) {
    return 'n/a';
  }

  const milliseconds = Number(duration);
  if (milliseconds < 1000) {
    return `${milliseconds} ms`;
  }

  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function buildRuntimeStats(runtime) {
  if (!runtime) {
    return [];
  }

  return [
    ['Stage', runtime.phaseLabel || runtime.phase || 'unknown'],
    ['Model', runtime.currentModel || 'tool execution'],
    ['Prompt tokens', runtime.usage?.promptEvalCount ?? 'n/a'],
    ['Output tokens', runtime.usage?.evalCount ?? 'n/a'],
    ['Load time', formatDuration(runtime.usage?.loadDuration)],
    ['Total time', formatDuration(runtime.usage?.totalDuration)],
  ];
}

function isTaskWaitingApproval(taskDetail) {
  return taskDetail?.task?.status === 'waiting_approval';
}

function hasToken() {
  return Boolean(sessionStorage.getItem(tokenKey));
}

function toErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Unexpected UI error';
}

function buildNetworkError(path) {
  return `Cannot reach LocalClaw at ${path}. Verify the control API is listening on ${controlApiOrigin} and reload the UI.`;
}

async function api(path, options = {}) {
  const token = sessionStorage.getItem(tokenKey) || '';
  let response;

  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      headers: {
        'content-type': 'application/json',
        ...(options.method && options.method !== 'GET' && token
          ? { authorization: `Bearer ${token}` }
          : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    throw new Error(buildNetworkError(path), {
      cause: error,
    });
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Paste CONTROL_API_TOKEN into the token box before using chat, approvals, projects, or planning.');
    }
    if (payload.error === 'validation_error' && Array.isArray(payload.details) && payload.details.length > 0) {
      const detail = payload.details[0];
      const field = Array.isArray(detail.path) && detail.path.length > 0 ? detail.path.join('.') : 'request';
      throw new Error(`${field}: ${detail.message}`);
    }
    throw new Error(payload.message || `${response.status} ${response.statusText}`);
  }
  return payload.data;
}

function TokenBox({ tokenReady, onChange }) {
  const [token, setToken] = useState(() => sessionStorage.getItem(tokenKey) || '');

  return (
    <section className={`token-card ${tokenReady ? 'ready' : 'missing'}`}>
      <div>
        <span className="dot" />
        <strong>{tokenReady ? 'Mutations enabled' : 'Read-only mode'}</strong>
        <p>{tokenReady ? 'Token is stored in this browser session.' : 'Paste CONTROL_API_TOKEN to chat, approve, or plan.'}</p>
      </div>
      <input
        value={token}
        type="password"
        placeholder="CONTROL_API_TOKEN"
        onChange={(event) => {
          const next = event.target.value.trim();
          setToken(next);
          if (next) {
            sessionStorage.setItem(tokenKey, next);
          } else {
            sessionStorage.removeItem(tokenKey);
          }
          onChange?.(Boolean(next));
        }}
      />
    </section>
  );
}

function StatusStrip({ status }) {
  const queue = status?.queue || {};
  const cards = [
    ['Runtime', status?.status || 'unknown'],
    ['Boot', status?.bootPhase || 'unknown'],
    ['Pending', queue.pending_count ?? 0],
    ['Running', queue.in_progress_count ?? 0],
    ['Blocked', queue.blocked_count ?? 0],
    ['Waiting', queue.waiting_approval_count ?? 0],
  ];

  return (
    <section className="status-strip">
      {cards.map(([label, value]) => (
        <article className="metric" key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </article>
      ))}
    </section>
  );
}

function Tasks({ tasks, selectedTask, onSelect }) {
  return (
    <section className="panel list-panel">
      <PanelTitle eyebrow="Queue" title="Tasks" detail={`${tasks.length} active`} />
      <div className="list">
        {tasks.map((task) => (
          <button
            className={`row ${selectedTask?.task?.id === task.id ? 'selected' : ''}`}
            key={task.id}
            onClick={() => onSelect(task.id)}
          >
            <span>{task.title}</span>
            <b data-status={task.status}>{task.status}</b>
          </button>
        ))}
        {tasks.length === 0 && <Empty text="No active tasks." />}
      </div>
    </section>
  );
}

function TaskDetail({ task, tokenReady, onApproveExecution }) {
  if (!task) {
    return (
      <section className="panel detail-panel">
        <Empty text="Select a task to inspect the plan, logs, and result state." />
      </section>
    );
  }

  const plan = task.task.result?.preExecutionPlan?.plan;

  return (
    <section className="panel detail-panel">
      <PanelTitle eyebrow="Task Detail" title={task.task.title} detail={task.task.status} />
      <RuntimePanel
        taskDetail={task}
        tokenReady={tokenReady}
        onApproveExecution={onApproveExecution}
      />
      {plan && (
        <div className="plan-box">
          <h3>{plan.summary}</h3>
          {(plan.steps || []).map((step) => (
            <div className="timeline-row" key={step.stepNumber}>
              <span>{step.stepNumber}</span>
              <p>{step.objective}</p>
              <code>{step.tool}</code>
            </div>
          ))}
        </div>
      )}
      {!plan && <pre>{JSON.stringify(task.task.result || {}, null, 2)}</pre>}
      <h3>Execution Log</h3>
      <div className="logs">
        {task.logs.map((log) => (
          <div className="log-line" key={`${log.step_number}-${log.created_at}`}>
            <b>{log.step_type}</b>
            <span>{log.status}</span>
            <p>{log.output_summary || log.error_message || 'No summary'}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function RuntimePanel({ taskDetail, tokenReady = true, onApproveExecution = null }) {
  const runtime = taskDetail?.runtime;
  const checklist = runtime?.checklist || [];
  const stats = buildRuntimeStats(runtime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!taskDetail) {
    return null;
  }

  async function handleApprove() {
    if (!onApproveExecution || busy) {
      return;
    }

    try {
      setBusy(true);
      setError('');
      await onApproveExecution(taskDetail.task.id);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="runtime-panel">
      <div className="runtime-header">
        <div>
          <strong>Live run context</strong>
          <p>{runtime?.detail || 'Transient runtime details will appear here while the task is active.'}</p>
        </div>
        <div className="runtime-actions">
          <span>{runtime?.live ? 'live' : 'snapshot'}</span>
          {isTaskWaitingApproval(taskDetail) && (
            <button
              className="secondary runtime-approve"
              disabled={!tokenReady || busy}
              onClick={handleApprove}
            >
              {busy ? 'Approving...' : 'Approve execution'}
            </button>
          )}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="runtime-grid">
        {stats.map(([label, value]) => (
          <div className="runtime-stat" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      {runtime?.summary && <p className="runtime-summary">{runtime.summary}</p>}
      {runtime?.currentStep && (
        <div className="runtime-current">
          <span>Current item</span>
          <strong>{runtime.currentStep.objective}</strong>
          <code>{runtime.currentStep.tool}</code>
        </div>
      )}
      {checklist.length > 0 && (
        <div className="runtime-checklist">
          <div className="runtime-checklist-header">
            <strong>Tasks to complete</strong>
            <span>{runtime?.counts?.completed ?? 0}/{runtime?.counts?.total ?? checklist.length} done</span>
          </div>
          <div className="runtime-checklist-list">
            {checklist.map((item) => (
              <div className={`runtime-checklist-item ${item.status}`} key={item.stepNumber}>
                <span>{item.stepNumber}</span>
                <div>
                  <strong>{item.objective}</strong>
                  <p>{item.tool}</p>
                </div>
                <b>{item.status}</b>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Approvals({ approvals, mutate, tokenReady }) {
  const [error, setError] = useState('');

  async function handleAction(path, body) {
    try {
      setError('');
      await mutate(path, body);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  return (
    <section className="panel">
      <PanelTitle eyebrow="Gates" title="Approvals" detail={`${approvals.length} pending`} />
      {error && <div className="error">{error}</div>}
      <div className="list">
        {approvals.map((approval) => (
          <div className="approval" key={approval.id}>
            <div>
              <b>{approval.task_title || approval.id}</b>
              <p>{approval.target_env || 'production'}</p>
            </div>
            <div className="actions compact">
              <button
                disabled={!tokenReady}
                onClick={() => handleAction(`/v1/approvals/${approval.id}/approve`, {})}
              >
                Approve
              </button>
              <button
                disabled={!tokenReady}
                className="ghost"
                onClick={() =>
                  handleAction(`/v1/approvals/${approval.id}/reject`, {
                    reason: 'Rejected via UI',
                  })
                }
              >
                Reject
              </button>
            </div>
          </div>
        ))}
        {approvals.length === 0 && <Empty text="No pending deploy approvals." />}
      </div>
    </section>
  );
}

function Chat({ sessions, actors, projects, tokenReady, onRefresh, onSelectTask }) {
  const [activeSession, setActiveSession] = useState(null);
  const [sessionDetail, setSessionDetail] = useState(null);
  const [message, setMessage] = useState('');
  const [actor, setActor] = useState('architect');
  const [projectPath, setProjectPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [runtimeTaskDetail, setRuntimeTaskDetail] = useState(null);

  useEffect(() => {
    if (!projectPath && projects[0]?.root_path) {
      setProjectPath(projects[0].root_path);
    }
  }, [projectPath, projects]);

  useEffect(() => {
    if (actors.length > 0 && !actors.some((item) => item.id === actor)) {
      setActor(actors[0].id);
    }
  }, [actor, actors]);

  async function loadSession(id) {
    setError('');
    setActiveSession(id);
    try {
      setSessionDetail(await api(`/v1/chat/sessions/${id}`));
    } catch (nextError) {
      setSessionDetail(null);
      setError(toErrorMessage(nextError));
    }
  }

  async function createSession() {
    if (!tokenReady) {
      throw new Error('Paste CONTROL_API_TOKEN first. Chat sessions are stored, so they require mutation access.');
    }
    const session = await api('/v1/chat/sessions', {
      method: 'POST',
      body: {
        title: 'Operator chat',
        actor,
        projectPath: projectPath || undefined,
      },
    });
    await onRefresh();
    await loadSession(session.id);
    return session;
  }

  async function sendMessage() {
    if (!message.trim() || busy) return;
    setBusy(true);
    setError('');

    try {
      const sessionId = activeSession || (await createSession()).id;
      await api(`/v1/chat/sessions/${sessionId}/messages`, {
        method: 'POST',
        body: { content: message, actor },
      });
      setMessage('');
      await loadSession(sessionId);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  async function planTask() {
    if (!message.trim() || busy) return;
    setBusy(true);
    setError('');

    try {
      const sessionId = activeSession || (await createSession()).id;
      await api(`/v1/chat/sessions/${sessionId}/plan-task`, {
        method: 'POST',
        body: { objective: message },
      });
      setMessage('');
      await loadSession(sessionId);
      await onRefresh();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  }

  const activeProject = projects.find((project) => project.root_path === projectPath);
  const sessionTasks = sessionDetail?.tasks || [];
  const activeRuntimeTask = useMemo(
    () => sessionTasks.find((task) => liveTaskStatuses.has(task.status)) || sessionTasks[0] || null,
    [sessionTasks]
  );

  useEffect(() => {
    if (!activeRuntimeTask?.id) {
      setRuntimeTaskDetail(null);
      return undefined;
    }

    let cancelled = false;

    const loadRuntimeTask = async () => {
      try {
        const detail = await api(`/v1/tasks/${activeRuntimeTask.id}`);
        if (!cancelled) {
          setRuntimeTaskDetail(detail);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(toErrorMessage(nextError));
        }
      }
    };

    loadRuntimeTask();

    if (!liveTaskStatuses.has(activeRuntimeTask.status)) {
      return () => {
        cancelled = true;
      };
    }

    const timer = setInterval(loadRuntimeTask, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeRuntimeTask?.id, activeRuntimeTask?.status]);

  async function approveExecution(taskId) {
    if (!tokenReady) {
      throw new Error('Paste CONTROL_API_TOKEN first.');
    }

    if (activeSession) {
      await api(`/v1/chat/sessions/${activeSession}/approve-task`, {
        method: 'POST',
        body: { taskId },
      });
      await loadSession(activeSession);
    } else {
      await api(`/v1/tasks/${taskId}/approve-execution`, {
        method: 'POST',
      });
    }

    setRuntimeTaskDetail(await api(`/v1/tasks/${taskId}`));
    await onRefresh();
  }

  return (
    <section className="chat-workspace">
      <aside className="chat-side panel">
        <PanelTitle eyebrow="Actor" title="Conversation" detail={tokenReady ? 'ready' : 'token required'} />
        <label>
          Actor
          <select value={actor} onChange={(event) => setActor(event.target.value)}>
            {actors.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
        <label>
          Project
          <select value={projectPath} onChange={(event) => setProjectPath(event.target.value)}>
            <option value="">No project selected</option>
            {projects.map((project) => (
              <option key={project.id} value={project.root_path}>{project.name}</option>
            ))}
          </select>
        </label>
        <button disabled={!tokenReady || busy} onClick={() => createSession().catch((nextError) => setError(nextError.message))}>New session</button>
        <div className="session-list">
          {sessions.map((session) => (
            <button
              className={`session ${activeSession === session.id ? 'selected' : ''}`}
              key={session.id}
              onClick={() => loadSession(session.id)}
            >
              <span>{session.title}</span>
              <small>{session.actor}</small>
            </button>
          ))}
        </div>
      </aside>
      <main className="panel chat-main">
        <div className="chat-header">
          <div>
            <p className="eyebrow">LocalClaw Chat</p>
            <h2>{sessionDetail?.session?.title || 'Start a controlled conversation'}</h2>
          </div>
          <div className="context-pill">{activeProject?.name || 'No project'}</div>
        </div>
        <div className="messages">
          {!sessionDetail && (
            <div className="message assistant">
              <b>assistant</b>
              <p>Paste the token, confirm the project, then type normally. `Send` keeps this in discussion mode. `Plan task` creates a tracked task and waits for approval before execution.</p>
            </div>
          )}
          {(sessionDetail?.messages || []).map((item) => (
            <div className={`message ${item.role}`} key={item.id}>
              <b>{item.role}{item.actor ? ` / ${item.actor}` : ''}</b>
              <p>{item.content}</p>
            </div>
          ))}
          {busy && (
            <div className="message assistant pending">
              <b>assistant</b>
              <p>Working. If the local model is slow, I will fall back instead of hanging.</p>
            </div>
          )}
        </div>
        <section className="task-hints">
          <div className="task-hint-card">
            <strong>What chat expects</strong>
            <p>Use `Send` for questions, scoping, and drafting. Use `Plan task` when you want LocalClaw to create a real task from the current prompt.</p>
          </div>
          <div className="task-hint-card">
            <strong>Where progress shows</strong>
            <p>Planned or approved work appears below as session tasks and in the `Tasks` view. `Send` by itself does not start execution.</p>
          </div>
        </section>
        {runtimeTaskDetail && (
          <RuntimePanel
            taskDetail={runtimeTaskDetail}
            tokenReady={tokenReady}
            onApproveExecution={approveExecution}
          />
        )}
        <section className="session-task-panel">
          <div className="session-task-header">
            <strong>Session tasks</strong>
            <span>{sessionTasks.length > 0 ? `${sessionTasks.length} linked` : 'none yet'}</span>
          </div>
          {sessionTasks.length === 0 && (
            <div className="empty compact-empty">
              No task has been created in this chat yet. Enter the request, then click `Plan task`.
            </div>
          )}
          {sessionTasks.length > 0 && (
            <div className="session-task-list">
              {sessionTasks.map((task) => (
                <button
                  className="session-task"
                  key={task.id}
                  onClick={() => onSelectTask(task.id)}
                >
                  <div>
                    <strong>{task.title}</strong>
                    <p>{new Date(task.updated_at || task.created_at).toLocaleString()}</p>
                  </div>
                  <span>{task.status}</span>
                </button>
              ))}
            </div>
          )}
        </section>
        {error && <div className="error">{error}</div>}
        <textarea
          value={message}
          placeholder={tokenReady ? 'Ask LocalClaw to review, plan, analyze, or draft...' : 'Paste CONTROL_API_TOKEN above to enable chat'}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              sendMessage();
            }
          }}
        />
        <div className="actions">
          <button disabled={!tokenReady || busy || !message.trim()} onClick={sendMessage}>{busy ? 'Working...' : 'Send'}</button>
          <button disabled={!tokenReady || busy || !message.trim()} className="secondary" onClick={planTask}>Plan task</button>
          <span className="hint">Cmd/Ctrl + Enter sends</span>
        </div>
      </main>
    </section>
  );
}

function Projects({ projects, allowedRoots, mutate, onRefresh, tokenReady }) {
  const [rootPath, setRootPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  async function addProject() {
    try {
      setError('');
      await mutate('/v1/projects', { rootPath, name: name || undefined });
      setRootPath('');
      setName('');
      await onRefresh();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function deleteProject(project) {
    const confirmed = window.confirm(`Remove project "${project.name}" from LocalClaw?`);
    if (!confirmed) {
      return;
    }

    try {
      setError('');
      await mutate(`/v1/projects/${project.id}`, null, 'DELETE');
      await onRefresh();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  return (
    <section className="panel">
      <PanelTitle eyebrow="Workspace Allowlist" title="Projects" detail={`${projects.length} registered`} />
      <p className="muted">Allowed roots: {allowedRoots.join(', ') || 'No workspace roots configured.'}</p>
      <div className="inline-form">
        <input value={name} placeholder="Name" onChange={(event) => setName(event.target.value)} />
        <input value={rootPath} placeholder="/path/to/project" onChange={(event) => setRootPath(event.target.value)} />
        <button disabled={!tokenReady || !rootPath} onClick={addProject}>Add</button>
      </div>
      {error && <div className="error">{error}</div>}
      {projects.map((project) => (
        <div className="project" key={project.id}>
          <div>
            <b>{project.name}</b>
            <span>{project.root_path}</span>
          </div>
          <button
            disabled={!tokenReady}
            className="ghost danger-button"
            onClick={() => deleteProject(project)}
          >
            Delete
          </button>
        </div>
      ))}
    </section>
  );
}

function Skills({ skills }) {
  return (
    <section className="panel">
      <PanelTitle eyebrow="Capabilities" title="Skills" detail={`${skills.length} registered`} />
      {skills.map((skill) => (
        <div className="project" key={skill.name}>
          <b>{skill.name}</b>
          <span>runs={skill.total_runs} enabled={skill.is_enabled ? 'yes' : 'no'}</span>
        </div>
      ))}
    </section>
  );
}

function Diagnostics({ status, error }) {
  return (
    <section className="panel detail-panel">
      <PanelTitle eyebrow="Runtime" title="Diagnostics" detail="local service" />
      {error && <div className="error">{error}</div>}
      <pre>{JSON.stringify(status || {}, null, 2)}</pre>
    </section>
  );
}

function PanelTitle({ eyebrow, title, detail }) {
  return (
    <div className="panel-title">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {detail && <span>{detail}</span>}
    </div>
  );
}

function Empty({ text }) {
  return <div className="empty">{text}</div>;
}

function App() {
  const [state, setState] = useState({
    status: null,
    tasks: [],
    approvals: [],
    skills: [],
    actors: [],
    sessions: [],
    projects: [],
    allowedRoots: [],
  });
  const [activeView, setActiveView] = useState('chat');
  const [selectedTask, setSelectedTask] = useState(null);
  const [error, setError] = useState('');
  const [tokenReady, setTokenReady] = useState(hasToken());
  const [lastRefresh, setLastRefresh] = useState(null);
  const hasRefreshSnapshotRef = useRef(false);

  const refresh = async () => {
    const results = await Promise.allSettled(
      dashboardLoaders.map((resource) => resource.load())
    );
    const nextState = {};
    const errors = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        dashboardLoaders[index].apply(nextState, result.value);
        return;
      }

      errors.push(toErrorMessage(result.reason));
    });

    if (Object.keys(nextState).length > 0) {
      setState((current) => ({
        ...current,
        ...nextState,
      }));
      hasRefreshSnapshotRef.current = true;
      setLastRefresh(new Date());
    }

    const uniqueErrors = [...new Set(errors)];
    setError(
      uniqueErrors.length > 0
        ? `${uniqueErrors.join(' ')}${hasRefreshSnapshotRef.current ? ' Showing the last successful snapshot.' : ''}`
        : ''
    );
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, []);

  const mutate = useMemo(
    () => async (path, body, method = 'POST') => {
      await api(path, { method, body });
      await refresh();
    },
    []
  );

  async function selectTask(taskId) {
    try {
      setError('');
      setSelectedTask(await api(`/v1/tasks/${taskId}`));
      setActiveView('tasks');
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  async function approveTaskExecution(taskId) {
    await api(`/v1/tasks/${taskId}/approve-execution`, {
      method: 'POST',
    });
    await refresh();
    setSelectedTask(await api(`/v1/tasks/${taskId}`));
    setActiveView('tasks');
  }

  const content = {
    chat: (
      <Chat
        sessions={state.sessions}
        actors={state.actors}
        projects={state.projects}
        tokenReady={tokenReady}
        onRefresh={refresh}
        onSelectTask={selectTask}
      />
    ),
    tasks: (
      <div className="split-view">
        <Tasks tasks={state.tasks} selectedTask={selectedTask} onSelect={selectTask} />
        <TaskDetail
          task={selectedTask}
          tokenReady={tokenReady}
          onApproveExecution={approveTaskExecution}
        />
      </div>
    ),
    approvals: <Approvals approvals={state.approvals} mutate={mutate} tokenReady={tokenReady} />,
    projects: (
      <Projects
        projects={state.projects}
        allowedRoots={state.allowedRoots}
        mutate={mutate}
        onRefresh={refresh}
        tokenReady={tokenReady}
      />
    ),
    skills: <Skills skills={state.skills} />,
    diagnostics: <Diagnostics status={state.status} error={error} />,
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span>LC</span>
          <div>
            <strong>LocalClaw</strong>
            <p>Operator Console</p>
          </div>
        </div>
        <nav>
          {navItems.map(([id, label]) => (
            <button className={activeView === id ? 'active' : ''} key={id} onClick={() => setActiveView(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span>{state.status?.bootPhase || 'unknown'}</span>
          <small>{lastRefresh ? `Updated ${lastRefresh.toLocaleTimeString()}` : 'Waiting for status'}</small>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">CLI-first agentic developer</p>
            <h1>{navItems.find(([id]) => id === activeView)?.[1]}</h1>
          </div>
          <button className="ghost" onClick={refresh}>Refresh</button>
        </header>
        {error && activeView !== 'diagnostics' && <div className="error">{error}</div>}
        <TokenBox tokenReady={tokenReady} onChange={(ready) => setTokenReady(ready)} />
        <StatusStrip status={state.status} />
        {content[activeView]}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
