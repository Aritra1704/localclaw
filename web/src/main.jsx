import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

const tokenKey = 'localclaw.controlToken';

async function api(path, options = {}) {
  const token = sessionStorage.getItem(tokenKey) || '';
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.method && options.method !== 'GET' && token
        ? { authorization: `Bearer ${token}` }
        : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || `${response.status} ${response.statusText}`);
  }
  return payload.data;
}

function TokenBox({ onChange }) {
  const [token, setToken] = useState(() => sessionStorage.getItem(tokenKey) || '');

  return (
    <section className="panel token-panel">
      <div>
        <p className="eyebrow">Mutation Token</p>
        <h2>Read-only until token is set</h2>
      </div>
      <input
        value={token}
        placeholder="CONTROL_API_TOKEN"
        onChange={(event) => {
          const next = event.target.value;
          setToken(next);
          if (next) {
            sessionStorage.setItem(tokenKey, next);
          } else {
            sessionStorage.removeItem(tokenKey);
          }
          onChange?.();
        }}
      />
    </section>
  );
}

function Dashboard({ status }) {
  const queue = status?.queue || {};
  const cards = [
    ['Status', status?.status || 'unknown'],
    ['Boot', status?.bootPhase || 'unknown'],
    ['Pending', queue.pending_count ?? 0],
    ['Running', queue.in_progress_count ?? 0],
    ['Blocked', queue.blocked_count ?? 0],
    ['Waiting', queue.waiting_approval_count ?? 0],
  ];

  return (
    <section className="grid cards">
      {cards.map(([label, value]) => (
        <article className="card" key={label}>
          <p>{label}</p>
          <strong>{value}</strong>
        </article>
      ))}
    </section>
  );
}

function Tasks({ tasks, selectedTask, onSelect }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Queue</p>
          <h2>Tasks</h2>
        </div>
      </div>
      <div className="list">
        {tasks.map((task) => (
          <button
            className={`row ${selectedTask?.task?.id === task.id ? 'selected' : ''}`}
            key={task.id}
            onClick={() => onSelect(task.id)}
          >
            <span>{task.title}</span>
            <b>{task.status}</b>
          </button>
        ))}
        {tasks.length === 0 && <p className="muted">No active tasks.</p>}
      </div>
    </section>
  );
}

function TaskDetail({ task }) {
  if (!task) {
    return (
      <section className="panel detail">
        <p className="muted">Select a task to inspect logs and result state.</p>
      </section>
    );
  }

  return (
    <section className="panel detail">
      <p className="eyebrow">Task Detail</p>
      <h2>{task.task.title}</h2>
      <p>{task.task.status}</p>
      <pre>{JSON.stringify(task.task.result?.preExecutionPlan?.plan || task.task.result || {}, null, 2)}</pre>
      <h3>Logs</h3>
      <div className="logs">
        {task.logs.map((log) => (
          <div key={`${log.step_number}-${log.created_at}`}>
            <b>{log.step_type}</b> {log.status}: {log.output_summary || log.error_message}
          </div>
        ))}
      </div>
    </section>
  );
}

function Approvals({ approvals, mutate }) {
  return (
    <section className="panel">
      <p className="eyebrow">Deploy Gates</p>
      <h2>Approvals</h2>
      <div className="list">
        {approvals.map((approval) => (
          <div className="approval" key={approval.id}>
            <span>{approval.task_title || approval.id}</span>
            <div>
              <button onClick={() => mutate(`/v1/approvals/${approval.id}/approve`, {})}>Approve</button>
              <button onClick={() => mutate(`/v1/approvals/${approval.id}/reject`, { reason: 'Rejected via UI' })}>
                Reject
              </button>
            </div>
          </div>
        ))}
        {approvals.length === 0 && <p className="muted">No pending deploy approvals.</p>}
      </div>
    </section>
  );
}

function Chat({ sessions, actors, projects, onRefresh }) {
  const [activeSession, setActiveSession] = useState(null);
  const [sessionDetail, setSessionDetail] = useState(null);
  const [message, setMessage] = useState('');
  const [actor, setActor] = useState('architect');
  const [projectPath, setProjectPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function loadSession(id) {
    setActiveSession(id);
    setSessionDetail(await api(`/v1/chat/sessions/${id}`));
  }

  async function createSession() {
    setError('');
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

  return (
    <section className="panel chat-panel">
      <div>
        <p className="eyebrow">Conversation</p>
        <h2>Chat Operator</h2>
      </div>
      <div className="chat-layout">
        <aside>
          <select value={actor} onChange={(event) => setActor(event.target.value)}>
            {actors.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <select value={projectPath} onChange={(event) => setProjectPath(event.target.value)}>
            <option value="">No project selected</option>
            {projects.map((project) => (
              <option key={project.id} value={project.root_path}>
                {project.name}
              </option>
            ))}
          </select>
          <button onClick={createSession}>New session</button>
          {sessions.map((session) => (
            <button className="session" key={session.id} onClick={() => loadSession(session.id)}>
              {session.title}
            </button>
          ))}
        </aside>
        <main>
          <div className="messages">
            {!sessionDetail && (
              <div className="message assistant">
                <b>assistant</b>
                <p>Select a session or type a message and I will create one automatically.</p>
              </div>
            )}
            {(sessionDetail?.messages || []).map((item) => (
              <div className={`message ${item.role}`} key={item.id}>
                <b>{item.role}</b>
                <p>{item.content}</p>
              </div>
            ))}
          </div>
          {error && <div className="error">{error}</div>}
          <textarea value={message} onChange={(event) => setMessage(event.target.value)} />
          <div className="actions">
            <button disabled={busy} onClick={sendMessage}>{busy ? 'Working...' : 'Send'}</button>
            <button disabled={busy} onClick={planTask}>Plan task</button>
          </div>
        </main>
      </div>
    </section>
  );
}

function Projects({ projects, allowedRoots, mutate, onRefresh }) {
  const [rootPath, setRootPath] = useState('');
  const [name, setName] = useState('');

  async function addProject() {
    await mutate('/v1/projects', { rootPath, name: name || undefined });
    setRootPath('');
    setName('');
    await onRefresh();
  }

  return (
    <section className="panel">
      <p className="eyebrow">Workspace Allowlist</p>
      <h2>Projects</h2>
      <p className="muted">{allowedRoots.join(', ') || 'No workspace roots configured.'}</p>
      <div className="inline-form">
        <input value={name} placeholder="Name" onChange={(event) => setName(event.target.value)} />
        <input value={rootPath} placeholder="/path/to/project" onChange={(event) => setRootPath(event.target.value)} />
        <button onClick={addProject}>Add</button>
      </div>
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
      <p className="eyebrow">Capabilities</p>
      <h2>Skills</h2>
      {skills.map((skill) => (
        <div className="project" key={skill.name}>
          <b>{skill.name}</b>
          <span>runs={skill.total_runs} enabled={skill.is_enabled ? 'yes' : 'no'}</span>
        </div>
      ))}
    </section>
  );
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
  const [selectedTask, setSelectedTask] = useState(null);
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      const [status, tasks, approvals, skills, actors, sessions, projectData] = await Promise.all([
        api('/v1/status'),
        api('/v1/tasks?limit=50'),
        api('/v1/approvals?limit=50'),
        api('/v1/skills?limit=50'),
        api('/v1/chat/actors'),
        api('/v1/chat/sessions?limit=20'),
        api('/v1/projects'),
      ]);
      setState({
        status,
        tasks,
        approvals,
        skills,
        actors,
        sessions,
        projects: projectData.projects || [],
        allowedRoots: projectData.allowedRoots || [],
      });
      setError('');
    } catch (nextError) {
      setError(nextError.message);
    }
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
    setSelectedTask(await api(`/v1/tasks/${taskId}`));
  }

  return (
    <div className="shell">
      <header>
        <p className="eyebrow">LocalClaw</p>
        <h1>Operator Console</h1>
        <button onClick={refresh}>Refresh</button>
      </header>
      {error && <div className="error">{error}</div>}
      <TokenBox onChange={refresh} />
      <Dashboard status={state.status} />
      <div className="two-col">
        <Tasks tasks={state.tasks} selectedTask={selectedTask} onSelect={selectTask} />
        <TaskDetail task={selectedTask} />
      </div>
      <div className="two-col">
        <Approvals approvals={state.approvals} mutate={mutate} />
        <Projects
          projects={state.projects}
          allowedRoots={state.allowedRoots}
          mutate={mutate}
          onRefresh={refresh}
        />
      </div>
      <Chat
        sessions={state.sessions}
        actors={state.actors}
        projects={state.projects}
        onRefresh={refresh}
      />
      <Skills skills={state.skills} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
