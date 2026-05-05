import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createKnowledgeGraphService } from '../src/memory/knowledgeGraph.js';

test('knowledge graph ingests files, symbols, dependencies, and doc references through MCP', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'localclaw-graph-'));
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, 'src', 'helper.js'),
    'export function helper() { return true; }\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(projectRoot, 'src', 'index.js'),
    [
      "import { helper } from './helper.js';",
      "import React from 'react';",
      'export function renderApp() { return helper(); }',
    ].join('\n'),
    'utf8'
  );
  await fs.writeFile(
    path.join(projectRoot, 'README.md'),
    '[See helper](./src/helper.js)\n',
    'utf8'
  );

  const nodes = new Map();
  const edges = [];
  let nextId = 1;

  const graph = createKnowledgeGraphService({
    pool: {
      async query() {
        throw new Error('Direct pool.query should not be used when MCP server is available');
      },
    },
    mcpRegistry: {
      getServer(name) {
        if (name !== 'postgres') {
          return null;
        }

        return {
          async callTool(toolName, args) {
            switch (toolName) {
              case 'upsert_graph_node': {
                const existing = nodes.get(args.nodeKey) ?? {
                  id: `node-${nextId++}`,
                };
                const row = {
                  ...existing,
                  node_key: args.nodeKey,
                  node_type: args.nodeType,
                  display_name: args.displayName,
                  source_path: args.sourcePath ?? null,
                  metadata: args.metadata ?? {},
                };
                nodes.set(args.nodeKey, row);
                return { rows: [row] };
              }
              case 'delete_graph_nodes_by_source_path': {
                for (const [key, value] of [...nodes.entries()]) {
                  if (
                    value.source_path === args.sourcePath &&
                    (!args.nodeTypes || args.nodeTypes.includes(value.node_type))
                  ) {
                    nodes.delete(key);
                  }
                }
                return { rowCount: 0, rows: [] };
              }
              case 'delete_graph_edges_from_node': {
                for (let index = edges.length - 1; index >= 0; index -= 1) {
                  if (edges[index].from_node_id === args.nodeId) {
                    edges.splice(index, 1);
                  }
                }
                return { rowCount: 0, rows: [] };
              }
              case 'upsert_graph_edge': {
                edges.push({
                  from_node_id: args.fromNodeId,
                  to_node_id: args.toNodeId,
                  edge_type: args.edgeType,
                  metadata: args.metadata ?? {},
                });
                return { rows: [edges.at(-1)] };
              }
              default:
                throw new Error(`Unexpected MCP tool: ${toolName}`);
            }
          },
        };
      },
    },
  });

  const summary = await graph.ingestProjectGraph({ projectRoot });

  assert.equal(summary.scanned, 3);
  assert.equal([...nodes.values()].some((node) => node.node_type === 'symbol' && node.display_name === 'renderApp'), true);
  assert.equal([...nodes.values()].some((node) => node.node_type === 'dependency' && node.display_name === 'react'), true);
  assert.equal(edges.some((edge) => edge.edge_type === 'imports'), true);
  assert.equal(edges.some((edge) => edge.edge_type === 'depends_on'), true);
  assert.equal(edges.some((edge) => edge.edge_type === 'references'), true);
});

test('knowledge graph retrieval formats matched architecture and recent changes', async () => {
  const graph = createKnowledgeGraphService({
    pool: {
      async query() {
        throw new Error('Direct pool.query should not be used when MCP server is available');
      },
    },
    mcpRegistry: {
      getServer(name) {
        return name === 'postgres'
          ? {
              async callTool(toolName) {
                if (toolName !== 'search_graph_context') {
                  throw new Error(`Unexpected MCP tool: ${toolName}`);
                }

                return {
                  matches: [
                    {
                      node_type: 'file',
                      display_name: 'index.js',
                      source_path: 'src/index.js',
                    },
                  ],
                  relationships: [
                    {
                      edge_type: 'imports',
                      from_name: 'index.js',
                      to_name: 'helper.js',
                    },
                  ],
                  recentChanges: [
                    {
                      title: 'Refactor index module',
                      status: 'done',
                      relative_path: 'src/index.js',
                    },
                  ],
                  relatedLearnings: [
                    {
                      category: 'execution',
                      observation: 'Touch helper imports carefully during refactors.',
                      confidence_score: 8,
                    },
                  ],
                };
              },
            }
          : null;
      },
    },
  });

  const context = await graph.retrieveRelevantContext('index helper dependency');

  assert.ok(context);
  assert.match(context.lines.join('\n'), /Architecture graph:/);
  assert.match(context.lines.join('\n'), /Impact relationships:/);
  assert.match(context.lines.join('\n'), /Historical changes:/);
  assert.match(context.lines.join('\n'), /Historical learnings:/);
});

test('knowledge graph impact analysis summarizes targets, dependents, and cautions', async () => {
  const graph = createKnowledgeGraphService({
    pool: {
      async query() {
        throw new Error('Direct pool.query should not be used when MCP server is available');
      },
    },
    mcpRegistry: {
      getServer(name) {
        return name === 'postgres'
          ? {
              async callTool(toolName) {
                if (toolName !== 'search_graph_context') {
                  throw new Error(`Unexpected MCP tool: ${toolName}`);
                }

                return {
                  matches: [
                    {
                      node_type: 'file',
                      display_name: 'index.js',
                      source_path: 'src/index.js',
                    },
                  ],
                  relationships: [
                    {
                      edge_type: 'imports',
                      from_name: 'src/index.js',
                      from_path: 'src/index.js',
                      to_name: 'src/helper.js',
                      to_path: 'src/helper.js',
                    },
                    {
                      edge_type: 'references',
                      from_name: 'README.md',
                      from_path: 'README.md',
                      to_name: 'src/index.js',
                      to_path: 'src/index.js',
                    },
                  ],
                  recentChanges: [
                    {
                      title: 'Refactor index module',
                      status: 'done',
                      relative_path: 'src/index.js',
                    },
                  ],
                  relatedLearnings: [
                    {
                      category: 'execution',
                      observation: 'Touch helper imports carefully during refactors.',
                      confidence_score: 8,
                    },
                  ],
                };
              },
            }
          : null;
      },
    },
  });

  const analysis = await graph.analyzeImpact('update index and helper');

  assert.ok(analysis);
  assert.equal(analysis.riskLevel, 'medium');
  assert.equal(analysis.primaryTargets.includes('src/index.js'), true);
  assert.equal(analysis.upstreamDependencies.includes('src/helper.js'), true);
  assert.equal(analysis.downstreamDependents.includes('README.md'), true);
  assert.match(analysis.lines.join('\n'), /Semantic impact analysis:/);
});
