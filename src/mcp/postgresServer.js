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
  {
    name: 'list_skills_catalog',
    description: 'List skills with optional filters and metrics.',
  },
  {
    name: 'upsert_skill_definition',
    description: 'Insert or update a skill definition by name.',
  },
  {
    name: 'set_skill_enabled',
    description: 'Enable or disable a skill by name.',
  },
  {
    name: 'get_skill_by_name',
    description: 'Fetch a skill definition by name.',
  },
  {
    name: 'search_enabled_skills',
    description: 'Search enabled skills for relevant suggestions.',
  },
  {
    name: 'insert_skill_run',
    description: 'Insert a skill run audit row.',
  },
  {
    name: 'list_project_targets',
    description: 'List allowed project targets.',
  },
  {
    name: 'upsert_project_target',
    description: 'Insert or update a project target by root path.',
  },
  {
    name: 'get_project_target',
    description: 'Fetch a project target by id.',
  },
  {
    name: 'delete_project_target',
    description: 'Delete a project target by id.',
  },
  {
    name: 'list_chat_messages',
    description: 'List messages for a chat session.',
  },
  {
    name: 'get_chat_session',
    description: 'Fetch a chat session with project metadata.',
  },
  {
    name: 'insert_chat_session',
    description: 'Create a chat session.',
  },
  {
    name: 'list_chat_sessions',
    description: 'List chat sessions ordered by recency.',
  },
  {
    name: 'insert_chat_message',
    description: 'Insert a chat message for a session.',
  },
  {
    name: 'touch_chat_session',
    description: 'Refresh chat session updated_at.',
  },
  {
    name: 'update_chat_summary',
    description: 'Update a chat session summary.',
  },
  {
    name: 'insert_chat_summary',
    description: 'Insert a historical chat summary entry.',
  },
  {
    name: 'list_tasks_by_chat_session',
    description: 'List recent tasks linked to a chat session.',
  },
  {
    name: 'insert_approval',
    description: 'Insert an approval row.',
  },
  {
    name: 'update_approval_request_message',
    description: 'Store the outbound request message id on an approval.',
  },
  {
    name: 'list_pending_approvals',
    description: 'List pending Railway deploy approvals.',
  },
  {
    name: 'respond_to_approval',
    description: 'Mark an approval approved or rejected and return the linked task.',
  },
  {
    name: 'insert_deployment',
    description: 'Insert a deployment row.',
  },
  {
    name: 'update_deployment_record',
    description: 'Update a deployment row using a whitelisted patch.',
  },
  {
    name: 'update_deployments_by_approval',
    description: 'Update deployments that belong to an approval id.',
  },
  {
    name: 'list_ready_deployments',
    description: 'List deployments that are approved and ready to start.',
  },
  {
    name: 'list_active_deployments',
    description: 'List actively deploying rows that have a remote deployment id.',
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

const DEPLOYMENT_UPDATE_COLUMNS = new Map([
  ['status', 'text'],
  ['repo_url', 'text'],
  ['deploy_url', 'text'],
  ['log_snapshot', 'text'],
  ['provider', 'text'],
  ['target_env', 'text'],
  ['approval_id', 'uuid'],
  ['project_id', 'text'],
  ['environment_id', 'text'],
  ['service_id', 'text'],
  ['remote_deployment_id', 'text'],
  ['last_error', 'text'],
]);

function buildDeploymentUpdateStatement(deploymentId, patch = {}) {
  const sets = [];
  const values = [deploymentId];

  for (const [column, sqlType] of DEPLOYMENT_UPDATE_COLUMNS.entries()) {
    if (!Object.prototype.hasOwnProperty.call(patch, column)) {
      continue;
    }

    const placeholder = pushTypedValue(values, sqlType, patch[column]);
    sets.push(`${column} = ${placeholder}`);
  }

  if (patch.clear_last_error === true) {
    sets.push('last_error = NULL');
  }

  if (patch.touch_updated_at !== false) {
    sets.push('updated_at = NOW()');
  }

  if (patch.touch_completed_at === true) {
    sets.push('completed_at = NOW()');
  }

  if (sets.length === 0) {
    throw new Error('update_deployment_record requires at least one patch operation.');
  }

  return {
    sql: `UPDATE deployments SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
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

        case 'list_skills_catalog': {
          const includeDisabled = args.includeDisabled ?? true;
          const sourceType = args.sourceType ?? null;
          const limit = args.limit ?? 20;
          const includeMetrics = args.includeMetrics ?? true;
          const includeDefinition = args.includeDefinition ?? false;
          const definitionColumn = includeDefinition ? 'skills.definition,' : '';
          const metricsJoin = includeMetrics
            ? `LEFT JOIN (
                 SELECT
                   skill_id,
                   COUNT(*) AS total_runs,
                   COUNT(*) FILTER (WHERE status = 'success') AS success_runs,
                   COUNT(*) FILTER (WHERE status = 'error') AS failed_runs,
                   MAX(created_at) AS last_run_at
                 FROM skill_runs
                 GROUP BY skill_id
               ) AS metrics
               ON metrics.skill_id = skills.id`
            : '';
          const metricsColumns = includeMetrics
            ? `,
               COALESCE(metrics.total_runs, 0)::int AS total_runs,
               COALESCE(metrics.success_runs, 0)::int AS success_runs,
               COALESCE(metrics.failed_runs, 0)::int AS failed_runs,
               metrics.last_run_at`
            : '';

          const result = await pool.query(
            `SELECT
               skills.id,
               skills.name,
               skills.version,
               skills.source_type,
               skills.description,
               ${definitionColumn}
               skills.is_enabled,
               skills.updated_at
               ${metricsColumns}
             FROM skills
             ${metricsJoin}
             WHERE ($1::boolean OR skills.is_enabled = TRUE)
               AND ($2::text IS NULL OR skills.source_type = $2)
             ORDER BY skills.name ASC
             LIMIT $3`,
            [includeDisabled, sourceType, limit]
          );
          return { rows: result.rows };
        }

        case 'upsert_skill_definition': {
          const result = await pool.query(
            `INSERT INTO skills (
               id,
               name,
               version,
               source_type,
               description,
               definition,
               is_enabled,
               updated_at
             )
             VALUES (
               COALESCE($1::uuid, gen_random_uuid()),
               $2,
               $3,
               $4,
               $5,
               $6::jsonb,
               $7,
               NOW()
             )
             ON CONFLICT (name)
             DO UPDATE
             SET
               version = EXCLUDED.version,
               source_type = EXCLUDED.source_type,
               description = EXCLUDED.description,
               definition = EXCLUDED.definition,
               is_enabled = EXCLUDED.is_enabled,
               updated_at = NOW()
             RETURNING id, name, version, source_type, description, definition, is_enabled, updated_at`,
            [
              args.id ?? null,
              args.name,
              args.version,
              args.sourceType,
              args.description,
              JSON.stringify(args.definition ?? {}),
              args.isEnabled ?? true,
            ]
          );
          return { rows: result.rows };
        }

        case 'set_skill_enabled': {
          const result = await pool.query(
            `UPDATE skills
             SET
               is_enabled = $2,
               updated_at = NOW()
             WHERE name = $1
             RETURNING id, name, source_type, version, is_enabled`,
            [args.name, args.enabled]
          );
          return { rows: result.rows };
        }

        case 'get_skill_by_name': {
          const result = await pool.query(
            `SELECT
               id,
               name,
               version,
               source_type,
               description,
               definition,
               is_enabled,
               updated_at
             FROM skills
             WHERE name = $1
             LIMIT 1`,
            [args.name]
          );
          return { rows: result.rows };
        }

        case 'search_enabled_skills': {
          const patterns = Array.isArray(args.patterns) ? args.patterns : [];
          if (patterns.length === 0) {
            return { rows: [] };
          }

          const result = await pool.query(
            `SELECT
               name,
               version,
               description,
               source_type
             FROM skills
             WHERE is_enabled = TRUE
               AND (
                 name ILIKE ANY($1::text[])
                 OR description ILIKE ANY($1::text[])
                 OR definition::text ILIKE ANY($1::text[])
               )
             ORDER BY
               CASE source_type
                 WHEN 'builtin' THEN 1
                 WHEN 'manual' THEN 2
                 WHEN 'generated' THEN 3
                 ELSE 4
               END,
               updated_at DESC
             LIMIT $2`,
            [patterns, args.limit ?? 4]
          );
          return { rows: result.rows };
        }

        case 'insert_skill_run': {
          const result = await pool.query(
            `INSERT INTO skill_runs (
               skill_id,
               task_id,
               skill_version,
               status,
               duration_ms,
               error_message,
               input_payload,
               output_summary,
               updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW())
             RETURNING id`,
            [
              args.skillId,
              args.taskId ?? null,
              args.skillVersion,
              args.status,
              args.durationMs,
              args.errorMessage ?? null,
              JSON.stringify(args.inputPayload ?? {}),
              args.outputSummary ?? null,
            ]
          );
          return { rows: result.rows };
        }

        case 'list_project_targets': {
          const result = await pool.query(
            `SELECT id, name, root_path, created_at, updated_at
             FROM project_targets
             ORDER BY updated_at DESC, created_at DESC`
          );
          return { rows: result.rows };
        }

        case 'upsert_project_target': {
          const result = await pool.query(
            `INSERT INTO project_targets (name, root_path, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (root_path)
             DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()
             RETURNING id, name, root_path, created_at, updated_at`,
            [args.name, args.rootPath]
          );
          return { rows: result.rows };
        }

        case 'get_project_target': {
          const result = await pool.query(
            `SELECT id, name, root_path, created_at, updated_at
             FROM project_targets
             WHERE id = $1`,
            [args.id]
          );
          return { rows: result.rows };
        }

        case 'delete_project_target': {
          const result = await pool.query(
            `DELETE FROM project_targets
             WHERE id = $1
             RETURNING id, name, root_path, created_at, updated_at`,
            [args.id]
          );
          return { rows: result.rows };
        }

        case 'list_chat_messages': {
          const result = await pool.query(
            `SELECT id, session_id, role, actor, content, metadata, created_at
             FROM chat_messages
             WHERE session_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [args.sessionId, args.limit ?? 40]
          );
          return { rows: result.rows };
        }

        case 'get_chat_session': {
          const result = await pool.query(
            `SELECT
               chat_sessions.id,
               chat_sessions.title,
               chat_sessions.actor,
               chat_sessions.project_target_id,
               chat_sessions.project_path,
               chat_sessions.summary,
               chat_sessions.status,
               chat_sessions.created_at,
               chat_sessions.updated_at,
               project_targets.name AS project_name
             FROM chat_sessions
             LEFT JOIN project_targets ON project_targets.id = chat_sessions.project_target_id
             WHERE chat_sessions.id = $1`,
            [args.sessionId]
          );
          return { rows: result.rows };
        }

        case 'insert_chat_session': {
          const result = await pool.query(
            `INSERT INTO chat_sessions (title, actor, project_target_id, project_path)
             VALUES ($1, $2, $3, $4)
             RETURNING id, title, actor, project_target_id, project_path, summary, status, created_at, updated_at`,
            [args.title, args.actor, args.projectTargetId ?? null, args.projectPath ?? null]
          );
          return { rows: result.rows };
        }

        case 'list_chat_sessions': {
          const result = await pool.query(
            `SELECT
               chat_sessions.id,
               chat_sessions.title,
               chat_sessions.actor,
               chat_sessions.project_path,
               chat_sessions.summary,
               chat_sessions.status,
               chat_sessions.created_at,
               chat_sessions.updated_at,
               project_targets.name AS project_name
             FROM chat_sessions
             LEFT JOIN project_targets ON project_targets.id = chat_sessions.project_target_id
             ORDER BY chat_sessions.updated_at DESC
             LIMIT $1`,
            [args.limit ?? 30]
          );
          return { rows: result.rows };
        }

        case 'insert_chat_message': {
          const result = await pool.query(
            `INSERT INTO chat_messages (session_id, role, actor, content, metadata)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             RETURNING id, session_id, role, actor, content, metadata, created_at`,
            [args.sessionId, args.role, args.actor ?? null, args.content, JSON.stringify(args.metadata ?? {})]
          );
          return { rows: result.rows };
        }

        case 'touch_chat_session': {
          const result = await pool.query(
            `UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1 RETURNING id`,
            [args.sessionId]
          );
          return { rows: result.rows };
        }

        case 'update_chat_summary': {
          const result = await pool.query(
            `UPDATE chat_sessions
             SET summary = $2, updated_at = NOW()
             WHERE id = $1
             RETURNING id`,
            [args.sessionId, args.summary]
          );
          return { rows: result.rows };
        }

        case 'insert_chat_summary': {
          const result = await pool.query(
            `INSERT INTO chat_summaries (session_id, summary, message_count)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [args.sessionId, args.summary, args.messageCount ?? 0]
          );
          return { rows: result.rows };
        }

        case 'list_tasks_by_chat_session': {
          const result = await pool.query(
            `SELECT id, title, status, priority, created_at, updated_at
             FROM tasks
             WHERE chat_session_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [args.sessionId, args.limit ?? 20]
          );
          return { rows: result.rows };
        }

        case 'insert_approval': {
          const result = await pool.query(
            `INSERT INTO approvals (
               task_id,
               approval_type,
               status,
               requested_via,
               response_payload
             )
             VALUES ($1, $2, $3, $4, $5::jsonb)
             RETURNING id, task_id, requested_at`,
            [
              args.taskId,
              args.approvalType,
              args.status ?? 'pending',
              args.requestedVia ?? 'telegram',
              JSON.stringify(args.responsePayload ?? {}),
            ]
          );
          return { rows: result.rows };
        }

        case 'update_approval_request_message': {
          const result = await pool.query(
            `UPDATE approvals
             SET request_message_id = $2
             WHERE id = $1
             RETURNING id`,
            [args.approvalId, args.requestMessageId]
          );
          return { rows: result.rows };
        }

        case 'list_pending_approvals': {
          const result = await pool.query(
            `SELECT
               approvals.id,
               approvals.task_id,
               approvals.requested_at,
               tasks.title AS task_title,
               deployments.repo_url,
               deployments.target_env,
               deployments.service_id
             FROM approvals
             JOIN tasks ON tasks.id = approvals.task_id
             LEFT JOIN deployments ON deployments.approval_id = approvals.id
             WHERE approvals.status = 'pending'
               AND approvals.approval_type = 'railway_deploy'
             ORDER BY approvals.requested_at ASC
             LIMIT $1`,
            [args.limit ?? 10]
          );
          return { rows: result.rows };
        }

        case 'respond_to_approval': {
          const responsePayload = args.mergeResponsePayload ?? {};
          const result = await pool.query(
            `UPDATE approvals
             SET
               status = $2,
               responded_at = NOW(),
               response_payload = COALESCE(response_payload, '{}'::jsonb) || $3::jsonb
             WHERE id = $1
               AND status = 'pending'
             RETURNING id, task_id`,
            [args.approvalId, args.status, JSON.stringify(responsePayload)]
          );
          return { rows: result.rows };
        }

        case 'insert_deployment': {
          const result = await pool.query(
            `INSERT INTO deployments (
               task_id,
               provider,
               target_env,
               repo_url,
               status,
               approval_id,
               project_id,
               environment_id,
               service_id,
               updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
             RETURNING id`,
            [
              args.taskId,
              args.provider ?? 'railway',
              args.targetEnv,
              args.repoUrl ?? null,
              args.status ?? 'pending',
              args.approvalId ?? null,
              args.projectId ?? null,
              args.environmentId ?? null,
              args.serviceId ?? null,
            ]
          );
          return { rows: result.rows };
        }

        case 'update_deployment_record': {
          const statement = buildDeploymentUpdateStatement(args.deploymentId, args.patch ?? {});
          const result = await pool.query(statement.sql, statement.values);
          return { rows: result.rows };
        }

        case 'update_deployments_by_approval': {
          const values = [args.approvalId];
          const sets = [];
          const patch = args.patch ?? {};
          for (const [column, sqlType] of DEPLOYMENT_UPDATE_COLUMNS.entries()) {
            if (!Object.prototype.hasOwnProperty.call(patch, column)) {
              continue;
            }

            const placeholder = pushTypedValue(values, sqlType, patch[column]);
            sets.push(`${column} = ${placeholder}`);
          }

          if (patch.clear_last_error === true) {
            sets.push('last_error = NULL');
          }
          if (patch.touch_updated_at !== false) {
            sets.push('updated_at = NOW()');
          }
          if (patch.touch_completed_at === true) {
            sets.push('completed_at = NOW()');
          }
          if (sets.length === 0) {
            throw new Error('update_deployments_by_approval requires at least one patch operation.');
          }

          const result = await pool.query(
            `UPDATE deployments
             SET ${sets.join(', ')}
             WHERE approval_id = $1
             RETURNING id`,
            values
          );
          return { rows: result.rows };
        }

        case 'list_ready_deployments': {
          const result = await pool.query(
            `SELECT
               deployments.id AS deployment_id,
               deployments.task_id,
               deployments.project_id,
               deployments.environment_id,
               deployments.service_id,
               deployments.repo_url,
               tasks.title,
               tasks.result
             FROM deployments
             JOIN approvals ON approvals.id = deployments.approval_id
             JOIN tasks ON tasks.id = deployments.task_id
             WHERE approvals.status = 'approved'
               AND deployments.status IN ('approval_pending', 'approved')
             ORDER BY deployments.created_at ASC`
          );
          return { rows: result.rows };
        }

        case 'list_active_deployments': {
          const result = await pool.query(
            `SELECT
               deployments.id AS deployment_id,
               deployments.task_id,
               deployments.remote_deployment_id,
               deployments.service_id,
               deployments.environment_id,
               deployments.last_error,
               tasks.title
             FROM deployments
             JOIN tasks ON tasks.id = deployments.task_id
             WHERE deployments.status = 'deploying'
               AND deployments.remote_deployment_id IS NOT NULL
             ORDER BY deployments.updated_at ASC`
          );
          return { rows: result.rows };
        }

        default:
          throw new Error(`Unsupported PostgreSQL MCP tool: ${toolName}`);
      }
    },
  };
}
