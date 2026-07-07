// ESLint 9 flat config for the August Proxy desktop frontend.
// Enforces:
//   - no-explicit-any: warn (start), will escalate to error after Phase 2
//   - consistent-type-assertions: 'as' style
//   - React Hooks rules
//   - type-checked rules where reasonable
//
// Run with: `npm run lint`

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'web-dist/**',
      'src-tauri/**',
      'vite.config.js.timestamp-*',
      'vite.config.d.ts',
      'vite.config.js',
      'eslint.config.js',
      'postcss.config.js',
      'tailwind.config.cjs',
      'coverage/**',
      '**/__pycache__/**',
    ],
  },

  // Base recommended JS rules — apply to .js and .ts
  js.configs.recommended,

  // Type-checked rules — ONLY for files in src/ that are part of the
  // main tsconfig (so type info is available). Other files (.js configs,
  // vite.config.ts in tsconfig.node.json) skip these rules entirely.
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // Phase 0 starts as warn; Phase 2 escalates to error.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Surface unsafe uses of typed slots.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',

      // Prefer `as Foo` over `<Foo>value`.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as' },
      ],

      // React Hooks rules
      ...reactHooks.configs.recommended.rules,

      // Allow unused vars prefixed with underscore
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // ── snake_case → camelCase enforcement (Phase 0.2 of repo-wide rename) ──
      //
      // The built-in `camelcase` rule plus @typescript-eslint/naming-convention
      // provide the canonical surface: variables, functions, methods, params,
      // properties must be camelCase; types/classes/interfaces must be
      // PascalCase. Identifiers allowed by the snakeToCamelMulti deny-list are
      // mirrored in the camelcase rule's `allow` block above so that ESLint
      // stays aligned with the migration tool.
      //
      // The built-in `camelcase` rule flags snake_case identifiers.
      // The `allow` list covers wire-protocol identifiers that the LLM emits
      // literally (Anthropic tool names) and other identifiers that the
      // snakeToCamelMulti tool already knows to leave alone. We mirror the
      // deny-list from backend-py/scripts/deny_list.txt here so that ESLint
      // stays in sync.
      //
      // Properties must be camelCase; string keys (object literals like
      // localStorage key names) follow the in-source migration.
      'camelcase': [
        'error',
        {
          properties: 'always',
          allow: [
            'accumulated_reasoning', 'accumulated_text', 'always', 'anthropic_messages', 'august_composer_draft', 'august_last', 'browser_click', 'browser_evaluate', 'browser_get_content', 'browser_navigate',
            'browser_open', 'browser_screenshot', 'browser_scroll', 'browser_select', 'browser_snapshot', 'browser_type', 'browser_wait', 'budget_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
            'cancelled', 'chat_messages', 'cline', 'close_drawer', 'codex_responses', 'completed', 'completion_tokens', 'consolidation', 'content_block', 'content_block_delta',
            'content_block_start', 'content_block_stop', 'content_blocks', 'content_filter', 'default_api', 'default_format', 'delta_engine', 'desktop_click', 'desktop_list_windows', 'desktop_mouse_position',
            'desktop_open_url', 'desktop_press_key', 'desktop_screen_size', 'desktop_screenshot', 'desktop_type', 'final_output', 'finish_reason', 'focus_composer', 'function_call', 'function_name',
            'gemini', 'heuristic', 'in_progress', 'input_json_delta', 'input_tokens', 'insert_composer_text', 'is_error', 'kilo_code', 'marked_subagent_only', 'max_output_tokens',
            'max_tokens', 'mcp__workspace__bash', 'mcp__workspace__web_fetch', 'mcp__workspace__web_search', 'message_delta', 'message_id', 'message_start', 'message_stop', 'mutation_confirmation_result', 'mutation_pending_confirmation',
            'off', 'open_drawer', 'openai_chat', 'opencode', 'opencode_go', 'output_tokens', 'partial_json', 'prompt_tokens', 'proxy_context', 'proxy_debug',
            'proxy_incoming', 'proxy_model_route', 'proxy_status', 'proxy_tools', 'proxy_upstream', 'reasoning_content', 'reasoning_effort', 'review', 'session_only', 'set_drawer_section',
            'set_guard_mode', 'skill_genesis', 'stop_reason', 'stop_sequences', 'subagent_started', 'subagent_thinking', 'text_delta', 'thinking_delta', 'tool_call_id', 'tool_calls',
            'tool_progress', 'tool_result', 'tool_use', 'tool_use_id', 'top_k', 'top_p', 'total_tokens', 'workbench_describe_environment', 'workbench_diagnose_proxy', 'workbench_get_activity',
            'workbench_get_agent_job', 'workbench_list_agent_jobs', 'workbench_list_agent_registry', 'workbench_list_proxy_capabilities', 'workbench_run_team', 'workbench_spawn_subagent', 'workbench_system_info',
          ],
        },
      ],

      // Acceptable relaxation: namespace conventions vary in this codebase
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/triple-slash-reference': 'off',

      // React Refresh (HMR) — only require for entry components; we let it warn
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },

  // Tests can be looser — they often need to cast mocks.
  {
    files: [
      'src/**/__tests__/**/*.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      'src/test/**/*.{ts,tsx}',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);