const POSTGRES_TOOLS = [
  {
    name: 'get_agent_state',
    description: 'Read agent_state by key.',
  },
  {
    name: 'upsert_agent_state',
    description: 'Insert or update agent_state by key.',
  },
  {
    name: 'search_learnings',
    description: 'Fetch relevant learnings for a task query.',
  },
  {
    name: 'search_document_chunks',
    description: 'Fetch matching document chunks for a task query.',
  },
  {
    name: 'bump_learning_usage',
    description: 'Increment usage counters for learnings that were injected into context.',
  },
  {
    name: 'find_active_task_by_title',
    description: 'Find an active task by title and source to deduplicate follow-up work.',
  },
  {
    name: 'get_task_history',
    description: 'Retrieve recent task logs for operator or model context.',
  },
  {
    name: 'create_task',
    description: 'Insert a task row and return the created task.',
  },
  {
    name: 'get_task_by_id',
    description: 'Fetch a task by id with selectable detail level.',
  },
  {
    name: 'update_task_record',
    description: 'Apply a whitelisted task patch and return the updated row.',
  },
  {
    name: 'list_active_tasks',
    description: 'List tasks in active operator-visible states.',
  },
  {
    name: 'get_status_counts',
    description: 'Fetch queue, deployment, and approval counts for the status snapshot.',
  },
  {
    name: 'insert_agent_log',
    description: 'Insert an agent log row for a task step.',
  },
  {
    name: 'insert_task_artifact',
    description: 'Insert a task artifact row.',
  },
  {
    name: 'insert_learning',
    description: 'Insert a learning extracted from a task run.',
  },
  {
    name: 'touch_task_lease',
    description: 'Refresh lease and heartbeat timestamps for an in-flight task.',
  },
];

const TASK_UPDATE_COLUMNS = new Map([
  ['title', 'text'],
  ['description', 'text'],
  ['priority', 'text'],
  ['status', 'text'],
  ['source', 'text'],
  ['project_name', 'text'],
  ['project_path', 'text'],
  ['repo_url', 'text'],
  ['locked_by', 'text'],
  ['lease_expires_at', 'timestamptz'],
  ['retry_count', 'int'],
  ['max_retries', 'int'],
  ['blocked_reason', 'text'],
  ['result', 'jsonb'],
  ['started_at', 'timestamptz'],
  ['completed_at', 'timestamptz'],
  ['chat_session_id', 'uuid'],
]);

function pushTypedValue(values, sqlType, value) {
  values.push(sqlType === 'jsonb' ? JSON.stringify(value) : value);
  const placeholder = `$${values.length}`;
  return sqlType === 'jsonb' ? `${placeholder}::jsonb` : placeholder;
}

function buildTaskUpdateStatement(taskId, patch = {}) {
  const sets = [];
  const values = [taskId];

  for (const [column, sqlType] of TASK_UPDATE_COLUMNS.entries()) {
    if (!Object.prototype.hasOwnProperty.call(patch, column)) {
      continue;
    }

    const placeholder = pushTypedValue(values, sqlType, patch[column]);
    sets.push(`${column} = ${placeholder}`);
  }

  if (patch.clear_blocked_reason === true) {
    sets.push('blocked_reason = NULL');
  }

  if (patch.clear_lock === true) {
    sets.push('locked_by = NULL');
    sets.push('lease_expires_at = NULL');
  }

  if (patch.touch_lease === true) {
    sets.push(`lease_expires_at = NOW() + INTERVAL '5 minutes'`);
  }

  if (patch.touch_heartbeat === true) {
    sets.push('last_heartbeat_at = NOW()');
  }

  if (patch.touch_updated_at !== false) {
    sets.push('updated_at = NOW()');
  }

  if (patch.touch_completed_at === true) {
    sets.push('completed_at = NOW()');
  }

  if (sets.length === 0) {
    throw new Error('update_task_record requires at least one patch operation.');
  }

  return {
    sql: `UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    values,
  };
}

export function createPostgresMcpServer({ pool }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('PostgreSQL MCP server requires a pool with query().');
  }

  return {
    name: 'postgres',
    description: 'Standardized LocalClaw retrieval-oriented PostgreSQL access.',

    listTools() {
      return POSTGRES_TOOLS.map((tool) => ({ ...tool }));
    },

    async callTool(toolName, args = {}) {
      switch (toolName) {
        case 'get_agent_state': {
          const result = await pool.query(
            'SELECT value FROM agent_state WHERE state_key = $1',
            [args.key]
          );
          return { rows: result.rows };
        }

        case 'upsert_agent_state': {
          const result = await pool.query(
            `INSERT INTO agent_state (state_key, value, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (state_key)
             DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
             RETURNING state_key, value, updated_at`,
            [args.key, JSON.stringify(args.value)]
          );
          return { rows: result.rows };
        }

        case 'search_learnings': {
          const keywords = Array.isArray(args.keywords) ? args.keywords : [];
          if (keywords.length === 0) {
            return { rows: [] };
          }

          const result = await pool.query(
            `SELECT id, category, observation, confidence_score
             FROM learnings
             WHERE keywords && $1::text[]
             ORDER BY times_applied DESC, confidence_score DESC, created_at DESC
             LIMIT $2`,
            [keywords, args.limit ?? 5]
          );
          return { rows: result.rows };
        }

        case 'search_document_chunks': {
          const keywords = Array.isArray(args.keywords) ? args.keywords : [];
          if (keywords.length === 0) {
            return { rows: [] };
          }

          const result = await pool.query(
            `SELECT
               LEFT(document_chunks.content, 280) AS content,
               documents.title,
               documents.source_path
             FROM document_chunks
             JOIN documents ON documents.id = document_chunks.document_id
             WHERE document_chunks.content ILIKE ANY($1::text[])
             ORDER BY document_chunks.created_at DESC
             LIMIT $2`,
            [keywords.map((keyword) => `%${keyword}%`), args.limit ?? 4]
          );
          return { rows: result.rows };
        }

        case 'bump_learning_usage': {
          const learningIds = [...new Set((args.learningIds ?? []).filter(Boolean))];
          if (learningIds.length === 0) {
            return { rowCount: 0 };
          }

          const result = await pool.query(
            `UPDATE learnings
             SET times_applied = times_applied + 1
             WHERE id = ANY($1::uuid[])`,
            [learningIds]
          );
          return { rowCount: result.rowCount ?? 0 };
        }

        case 'find_active_task_by_title': {
          const statuses =
            Array.isArray(args.statuses) && args.statuses.length > 0
              ? args.statuses
              : ['pending', 'leased', 'in_progress', 'blocked', 'waiting_approval'];

          const result = await pool.query(
            `SELECT id
             FROM tasks
             WHERE title = $1
               AND source = $2
               AND status = ANY($3::text[])
             LIMIT 1`,
            [args.title, args.source, statuses]
          );
          return { rows: result.rows };
        }

        case 'get_task_history': {
          const taskResult = await this.callTool('get_task_by_id', {
            taskId: args.taskId,
            view: 'summary',
          });
          const logResult = await pool.query(
            `SELECT step_number, step_type, tool_called, model_used, status, output_summary, error_message, created_at
             FROM agent_logs
             WHERE task_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [args.taskId, args.limit ?? 20]
          );

          return {
            task: taskResult.rows[0] ?? null,
            logs: logResult.rows,
          };
        }

        case 'create_task': {
          const result = await pool.query(
            `INSERT INTO tasks (
               title,
               description,
               priority,
               source,
               project_name,
               project_path,
               chat_session_id,
               status
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, title, description, status, priority, source, project_name, project_path, chat_session_id, created_at`,
            [
              args.title,
              args.description,
              args.priority ?? 'medium',
              args.source ?? 'manual',
              args.projectName ?? null,
              args.projectPath ?? null,
              args.chatSessionId ?? null,
              args.status ?? 'pending',
            ]
          );
          return { rows: result.rows };
        }

        case 'get_task_by_id': {
          const view = args.view ?? 'detail';
          const result = await pool.query(
            view === 'summary'
              ? `SELECT id, title, status, priority, created_at, updated_at, completed_at, started_at
                 FROM tasks
                 WHERE id = $1`
              : `SELECT
                   id,
                   title,
                   description,
                   priority,
                   status,
                   source,
                   project_name,
                   project_path,
                   repo_url,
                   blocked_reason,
                   result,
                   created_at,
                   started_at,
                   completed_at,
                   updated_at
                 FROM tasks
                 WHERE id = $1`,
            [args.taskId]
          );
          return { rows: result.rows };
        }

        case 'update_task_record': {
          const statement = buildTaskUpdateStatement(args.taskId, args.patch ?? {});
          const result = await pool.query(statement.sql, statement.values);
          return { rows: result.rows };
        }

        case 'list_active_tasks': {
          const result = await pool.query(
            `SELECT id, title, status, priority, created_at, started_at, updated_at
             FROM tasks
             WHERE status = ANY($1::text[])
             ORDER BY
               CASE priority
                 WHEN 'critical' THEN 1
                 WHEN 'high' THEN 2
                 WHEN 'medium' THEN 3
                 WHEN 'low' THEN 4
                 ELSE 5
               END,
               created_at ASC
             LIMIT $2`,
            [
              args.statuses ?? ['pending', 'in_progress', 'verifying', 'blocked', 'waiting_approval'],
              args.limit ?? 10,
            ]
          );
          return { rows: result.rows };
        }

        case 'get_status_counts': {
          const [queueResult, deploymentResult, approvalResult] = await Promise.all([
            pool.query(
              `SELECT
                 COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
                 COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_count,
                 COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked_count,
                 COUNT(*) FILTER (WHERE status = 'waiting_approval')::int AS waiting_approval_count
               FROM tasks`
            ),
            pool.query(
              `SELECT COUNT(*)::int AS deploying_count
               FROM deployments
               WHERE status = 'deploying'`
            ),
            pool.query(
              `SELECT COUNT(*)::int AS pending_count
               FROM approvals
               WHERE status = 'pending'
                 AND approval_type = 'railway_deploy'`
            ),
          ]);

          return {
            queue: queueResult.rows[0] ?? null,
            deployments: deploymentResult.rows[0] ?? null,
            approvals: approvalResult.rows[0] ?? null,
          };
        }

        case 'insert_agent_log': {
          const result = await pool.query(
            `INSERT INTO agent_logs (
               task_id,
               step_number,
               step_type,
               model_used,
               tool_called,
               status,
               input_summary,
               output_summary,
               duration_ms,
               error_message
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id`,
            [
              args.taskId,
              args.stepNumber,
              args.stepType,
              args.modelUsed ?? null,
              args.toolCalled ?? null,
              args.status,
              args.inputSummary ?? null,
              args.outputSummary ?? null,
              args.durationMs ?? null,
              args.errorMessage ?? null,
            ]
          );
          return { rows: result.rows };
        }

        case 'insert_task_artifact': {
          const result = await pool.query(
            `INSERT INTO task_artifacts (
               task_id,
               artifact_type,
               artifact_path,
               metadata
             )
             VALUES ($1, $2, $3, $4::jsonb)
             RETURNING id`,
            [
              args.taskId,
              args.artifactType,
              args.artifactPath,
              JSON.stringify(args.metadata ?? {}),
            ]
          );
          return { rows: result.rows };
        }

        case 'insert_learning': {
          const result = await pool.query(
            `INSERT INTO learnings (
               task_id,
               category,
               observation,
               keywords,
               confidence_score
             )
             VALUES ($1, $2, $3, $4::text[], $5)
             RETURNING id`,
            [
              args.taskId ?? null,
              args.category ?? 'execution',
              args.observation,
              Array.isArray(args.keywords) ? args.keywords : [],
              args.confidenceScore ?? 5,
            ]
          );
          return { rows: result.rows };
        }

        case 'touch_task_lease': {
          const result = await pool.query(
            `UPDATE tasks
             SET
               lease_expires_at = NOW() + INTERVAL '5 minutes',
               last_heartbeat_at = NOW(),
               updated_at = NOW()
             WHERE id = $1
             RETURNING id`,
            [args.taskId]
          );
          return { rows: result.rows };
        }

        default:
          throw new Error(`Unsupported PostgreSQL MCP tool: ${toolName}`);
      }
    },
  };
}
