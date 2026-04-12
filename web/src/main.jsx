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

function TaskDetail({ task }) {
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

function Chat({ sessions, actors, projects, tokenReady, onRefresh }) {
  const [activeSession, setActiveSession] = useState(null);
  const [sessionDetail, setSessionDetail] = useState(null);
  const [message, setMessage] = useState('');
  const [actor, setActor] = useState('architect');
  const [projectPath, setProjectPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
              <p>Paste the token, confirm the project, then type normally. I will answer here and will not execute tasks without explicit approval.</p>
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
          <b>{project.name}</b>
          <span>{project.root_path}</span>
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
    () => async (path, body) => {
      await api(path, { method: 'POST', body });
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

  const content = {
    chat: (
      <Chat
        sessions={state.sessions}
        actors={state.actors}
        projects={state.projects}
        tokenReady={tokenReady}
        onRefresh={refresh}
      />
    ),
    tasks: (
      <div className="split-view">
        <Tasks tasks={state.tasks} selectedTask={selectedTask} onSelect={selectTask} />
        <TaskDetail task={selectedTask} />
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
