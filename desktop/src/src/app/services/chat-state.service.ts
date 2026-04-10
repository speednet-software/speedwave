import { Injectable, inject } from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { TauriService } from './tauri.service';
import { ProjectStateService } from './project-state.service';
import type {
  ChatMessage,
  MessageBlock,
  SessionStats,
  StreamChunk,
  ToolUseBlock,
  AskUserQuestionBlock,
  ProjectList,
  RateLimitInfo,
} from '../models/chat';

// Re-export types consumed by components
export type {
  ChatMessage,
  MessageBlock,
  StreamChunk,
  ProjectList,
  SessionStats,
  AskUserQuestionBlock,
  RateLimitInfo,
};

/** Maximum time to wait for a chat session to start before surfacing a timeout error. */
const SESSION_START_TIMEOUT_MS = 30_000;
/** Polling interval while waiting for a session to start. */
const SESSION_START_POLL_MS = 500;

/** Singleton service that holds chat session state across navigation. */
@Injectable({ providedIn: 'root' })
export class ChatStateService {
  private _messages: ChatMessage[] = [];
  /** Completed messages (immutable — replaced on each change). */
  get messages(): readonly ChatMessage[] {
    return this._messages;
  }

  private _currentBlocks: MessageBlock[] = [];
  /** Blocks accumulating during the current streaming assistant turn. */
  get currentBlocks(): readonly MessageBlock[] {
    return this._currentBlocks;
  }

  isStreaming = false;

  private _sessionStats: SessionStats | null = null;
  /** Session cost/usage stats from the most recent result. */
  get sessionStats(): SessionStats | null {
    return this._sessionStats;
  }

  private _model = '';
  private _rateLimit: RateLimitInfo | null = null;
  private _totalOutputTokens = 0;
  private _contextWindowSize = 200_000;

  private unlisten: UnlistenFn | null = null;
  private listenerReady = false;
  private initialized = false;
  private startingSession = false;
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private unsubProjectChange: (() => void) | null = null;

  /**
   * Test-only setter for private backing fields.
   * @internal
   * @param state - partial state to merge into the service
   */
  _setState(
    state: Partial<{
      messages: ChatMessage[];
      currentBlocks: MessageBlock[];
      sessionStats: SessionStats | null;
    }>
  ): void {
    if (state.messages !== undefined) this._messages = state.messages;
    if (state.currentBlocks !== undefined) this._currentBlocks = state.currentBlocks;
    if (state.sessionStats !== undefined) this._sessionStats = state.sessionStats;
  }

  /** Subscribers notified on every state change (components call markForCheck). */
  private changeListeners: Array<() => void> = [];

  /**
   * Registers a callback invoked on every state mutation.
   * @param cb - The callback to invoke on change.
   */
  onChange(cb: () => void): () => void {
    this.changeListeners.push(cb);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== cb);
    };
  }

  /** Notifies all registered change listeners. */
  private notifyChange(): void {
    for (const cb of this.changeListeners) {
      cb();
    }
  }

  /** Ensures the stream listener runs exactly once. Waits for project ready before starting chat. */
  async init(): Promise<void> {
    console.debug(
      '[chat-state] init: listenerReady=%s initialized=%s',
      this.listenerReady,
      this.initialized
    );
    if (!this.listenerReady) {
      this.listenerReady = true;
      await this.setupStreamListener();
      this.setupProjectStateListeners();
    }
    if (!this.initialized) {
      this.initialized = true;
      // Start chat session in the background — don't await so the UI stays
      // responsive.  If the user sends a message before start_chat completes,
      // sendMessage's auto-retry handles "no active session" transparently.
      if (this.projectState.status === 'ready') {
        this.startChatSession();
      } else {
        const unsub = this.projectState.onProjectReady(() => {
          unsub();
          this.startChatSession();
        });
      }
    }
  }

  private async startChatSession(): Promise<void> {
    const project = this.projectState.activeProject;
    if (project && !this.startingSession) {
      this.startingSession = true;
      console.debug('[chat-state] startChatSession: project=%s', project);
      try {
        await this.tauri.invoke('start_chat', { project });
        console.debug('[chat-state] startChatSession: success');
      } catch (err) {
        const msg = String(err);
        if (msg.includes('not authenticated')) {
          this.projectState.status = 'auth_required';
          this.notifyChange();
        } else {
          console.error('Failed to start chat session:', err);
        }
      } finally {
        this.startingSession = false;
      }
    }
  }

  /**
   * Sends a user message to Claude via the backend.
   * @param text - The message text to send.
   */
  async sendMessage(text: string): Promise<void> {
    if (!text || this.isStreaming) return;
    console.debug('[chat-state] sendMessage: isStreaming=%s', this.isStreaming);

    this._messages = [
      ...this._messages,
      {
        role: 'user',
        blocks: [{ type: 'text', content: text }],
        timestamp: Date.now(),
      },
    ];
    this.isStreaming = true;
    this._currentBlocks = [];
    this.notifyChange();

    try {
      await this.tauri.invoke('send_message', { message: text });
    } catch (err) {
      const errStr = String(err);
      // Session died (broken pipe, exited) — restart transparently
      if (
        errStr.includes('session exited') ||
        errStr.includes('no active session') ||
        errStr.includes('Broken pipe')
      ) {
        try {
          // If startChatSession is already in progress (from init), wait for
          // it to finish rather than starting a competing session.
          if (this.startingSession) {
            const deadline = Date.now() + SESSION_START_TIMEOUT_MS;
            while (this.startingSession && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, SESSION_START_POLL_MS));
            }
            if (this.startingSession) {
              // Timed out — session startup is still running (likely
              // container recreation).  Show an error instead of hanging.
              this.isStreaming = false;
              this._messages = [
                ...this._messages,
                {
                  role: 'assistant',
                  blocks: [
                    {
                      type: 'error',
                      content:
                        'Session is still starting (containers may be restarting). Please try again in a moment.',
                    },
                  ],
                  timestamp: Date.now(),
                },
              ];
              this.notifyChange();
              return;
            }
            // After waiting, try to send — session should be ready now
            try {
              await this.tauri.invoke('send_message', { message: text });
            } catch (postWaitErr) {
              this.isStreaming = false;
              this._messages = [
                ...this._messages,
                {
                  role: 'assistant',
                  blocks: [
                    {
                      type: 'error',
                      content: `Failed to send message after session started: ${postWaitErr}`,
                    },
                  ],
                  timestamp: Date.now(),
                },
              ];
              this.notifyChange();
            }
            return;
          }
          const result = await this.tauri.invoke<ProjectList>('list_projects');
          if (result.active_project) {
            this.startingSession = true;
            try {
              await this.tauri.invoke('start_chat', { project: result.active_project });
            } finally {
              this.startingSession = false;
            }
            await this.tauri.invoke('send_message', { message: text });
            return;
          }
          // No active project — surface actionable error
          this.isStreaming = false;
          this._messages = [
            ...this._messages,
            {
              role: 'assistant',
              blocks: [
                {
                  type: 'error',
                  content: 'No active project. Please select or add a project first.',
                },
              ],
              timestamp: Date.now(),
            },
          ];
          this.notifyChange();
          return;
        } catch (retryErr) {
          const retryMsg = String(retryErr);
          if (retryMsg.includes('not authenticated')) {
            this.projectState.status = 'auth_required';
            this.isStreaming = false;
            this.notifyChange();
            return;
          }
          this.isStreaming = false;
          this._messages = [
            ...this._messages,
            {
              role: 'assistant',
              blocks: [{ type: 'error', content: `Failed to restart session: ${retryErr}` }],
              timestamp: Date.now(),
            },
          ];
          this.notifyChange();
          return;
        }
      }
      this.isStreaming = false;
      this._messages = [
        ...this._messages,
        {
          role: 'assistant',
          blocks: [{ type: 'error', content: `Failed to send message: ${err}` }],
          timestamp: Date.now(),
        },
      ];
      this.notifyChange();
    }
  }

  /**
   * Sends an answer to an AskUserQuestion prompt back to Claude.
   * @param toolUseId - The tool_use_id of the AskUserQuestion.
   * @param selectedValues - The selected option value(s).
   */
  async answerQuestion(toolUseId: string, selectedValues: string[]): Promise<void> {
    const answer = selectedValues.join(', ');

    // Mark the question as answered in currentBlocks
    this._currentBlocks = this._currentBlocks.map((b) =>
      b.type === 'ask_user' && b.question.tool_id === toolUseId
        ? { ...b, question: { ...b.question, answered: true, selected_values: selectedValues } }
        : b
    );
    this.notifyChange();

    try {
      await this.tauri.invoke('answer_question', { toolUseId, answer });
    } catch (err) {
      this.isStreaming = false;
      // Revert the optimistic answered state so the user can retry
      this._currentBlocks = this._currentBlocks.map((b) =>
        b.type === 'ask_user' && b.question.tool_id === toolUseId
          ? { ...b, question: { ...b.question, answered: false, selected_values: [] } }
          : b
      );
      this._currentBlocks = [
        ...this._currentBlocks,
        { type: 'error', content: `Failed to send answer: ${err}` },
      ];
      this.notifyChange();
    }
  }

  /**
   * Processes a streaming chunk from the Claude subprocess.
   * Uses immutable updates: currentBlocks is replaced on every mutation.
   * @param chunk - The stream chunk to handle.
   */
  handleStreamChunk(chunk: StreamChunk): void {
    switch (chunk.chunk_type) {
      case 'Text':
        this.isStreaming = true;
        this._currentBlocks = appendOrCreateTextBlock(this._currentBlocks, chunk.data.content);
        break;

      case 'Thinking':
        this.isStreaming = true;
        this._currentBlocks = appendOrCreateThinkingBlock(this._currentBlocks, chunk.data.content);
        break;

      case 'ToolStart': {
        const newTool: ToolUseBlock = {
          type: 'tool_use',
          tool_id: chunk.data.tool_id,
          tool_name: chunk.data.tool_name,
          input_json: '',
          status: 'running',
          collapsed: false,
        };
        this._currentBlocks = [...this._currentBlocks, { type: 'tool_use', tool: newTool }];
        break;
      }

      case 'ToolInputDelta':
        this._currentBlocks = updateToolInput(
          this._currentBlocks,
          chunk.data.tool_id,
          chunk.data.partial_json
        );
        break;

      case 'ToolResult':
        this._currentBlocks = completeToolBlock(this._currentBlocks, chunk.data);
        break;

      case 'AskUserQuestion': {
        const askBlock: AskUserQuestionBlock = {
          tool_id: chunk.data.tool_id,
          question: chunk.data.question,
          options: chunk.data.options,
          header: chunk.data.header,
          multi_select: chunk.data.multi_select,
          answered: false,
          selected_values: [],
        };
        this._currentBlocks = [...this._currentBlocks, { type: 'ask_user', question: askBlock }];
        break;
      }

      case 'SystemInit':
        this._model = chunk.data.model;
        break;

      case 'RateLimit':
        if (chunk.data.utilization !== null) {
          this._rateLimit = {
            utilization: chunk.data.utilization,
            resets_at: chunk.data.resets_at,
          };
          // Update existing sessionStats immediately if present
          if (this._sessionStats) {
            this._sessionStats = { ...this._sessionStats, rate_limit: this._rateLimit };
          }
        }
        break;

      case 'Result':
        if (chunk.data.result_text) {
          // Only append result_text when no streamed text blocks exist yet.
          // Claude Code always copies the full response into `result`, so for
          // normal turns the text was already streamed via Text deltas.  Slash
          // commands (e.g. /cost) produce *only* a result — no text deltas.
          const hasStreamedText = this._currentBlocks.some((b) => b.type === 'text');
          if (!hasStreamedText) {
            this._currentBlocks = [
              ...this._currentBlocks,
              { type: 'text', content: chunk.data.result_text },
            ];
          }
        }
        if (this._currentBlocks.length > 0) {
          this._messages = [
            ...this._messages,
            { role: 'assistant', blocks: [...this._currentBlocks], timestamp: Date.now() },
          ];
          this._currentBlocks = [];
        }
        this.isStreaming = false;
        if (chunk.data.usage) {
          this._totalOutputTokens += chunk.data.usage.output_tokens;
        }
        if (chunk.data.context_window_size) {
          this._contextWindowSize = chunk.data.context_window_size;
        }
        this._sessionStats = {
          session_id: chunk.data.session_id,
          cost_usd: chunk.data.cost_usd ?? 0,
          total_cost: chunk.data.total_cost ?? 0,
          usage: chunk.data.usage,
          model: this._model || undefined,
          rate_limit: this._rateLimit ?? undefined,
          context_window_size: this._contextWindowSize,
          total_output_tokens: this._totalOutputTokens,
        };
        break;

      case 'Error':
        this._currentBlocks = [
          ...this._currentBlocks,
          { type: 'error', content: chunk.data.content },
        ];
        // Finalize as error turn
        this._messages = [
          ...this._messages,
          { role: 'assistant', blocks: [...this._currentBlocks], timestamp: Date.now() },
        ];
        this._currentBlocks = [];
        this.isStreaming = false;
        break;

      default:
        return; // unknown chunk type — no state change, no notification
    }
    this.notifyChange();
  }

  /** Clears all chat state to start a fresh conversation. */
  resetForNewConversation(): void {
    console.debug('[chat-state] resetForNewConversation');
    this._messages = [];
    this._currentBlocks = [];
    this.isStreaming = false;
    this._sessionStats = null;
    this._model = '';
    this._rateLimit = null;
    this._totalOutputTokens = 0;
    this._contextWindowSize = 200_000;
    this.initialized = false;
    this.startingSession = false;
    this.notifyChange();
  }

  /**
   * Replaces the current messages with a pre-loaded set (e.g. from a transcript).
   * @param msgs - The messages to load.
   */
  loadMessages(msgs: ChatMessage[]): void {
    this._messages = msgs;
    this.notifyChange();
  }

  /**
   * Subscribes to ProjectStateService for project switching lifecycle.
   * On switching: clears chat state immediately (cross-project leak prevention).
   */
  private setupProjectStateListeners(): void {
    this.unsubProjectChange = this.projectState.onChange(() => {
      if (this.projectState.status === 'switching') {
        this._messages = [];
        this._currentBlocks = [];
        this.isStreaming = false;
        this._sessionStats = null;
        this._model = '';
        this._rateLimit = null;
        this._totalOutputTokens = 0;
        this._contextWindowSize = 200_000;
        this.notifyChange();
      }
    });
  }

  /** Sets up the Tauri event listener for streaming chat responses. */
  private async setupStreamListener(): Promise<void> {
    try {
      this.unlisten = await this.tauri.listen<StreamChunk>('chat_stream', (event) => {
        this.handleStreamChunk(event.payload);
      });
    } catch (err) {
      if (this.tauri.isRunningInTauri()) {
        console.error('Failed to set up stream listener:', err);
        this.projectState.status = 'error';
        this.projectState.error = `Failed to set up stream listener: ${err}`;
      }
    }
  }
}

// ── Immutable helper functions ─────────────────────────────────────────

function appendOrCreateTextBlock(blocks: MessageBlock[], content: string): MessageBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') {
    return [...blocks.slice(0, -1), { type: 'text', content: last.content + content }];
  }
  return [...blocks, { type: 'text', content }];
}

function appendOrCreateThinkingBlock(blocks: MessageBlock[], content: string): MessageBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'thinking') {
    return [
      ...blocks.slice(0, -1),
      { type: 'thinking', content: last.content + content, collapsed: last.collapsed },
    ];
  }
  return [...blocks, { type: 'thinking', content, collapsed: true }];
}

function updateToolInput(blocks: MessageBlock[], toolId: string, delta: string): MessageBlock[] {
  return blocks.map((b) => {
    if (b.type !== 'tool_use' || b.tool.tool_id !== toolId) return b;
    return { ...b, tool: { ...b.tool, input_json: b.tool.input_json + delta } };
  });
}

function completeToolBlock(
  blocks: MessageBlock[],
  data: { tool_id: string; content: string; is_error: boolean }
): MessageBlock[] {
  return blocks.map((b) => {
    if (b.type !== 'tool_use' || b.tool.tool_id !== data.tool_id) return b;
    const base = {
      type: 'tool_use' as const,
      tool_id: b.tool.tool_id,
      tool_name: b.tool.tool_name,
      input_json: b.tool.input_json,
      collapsed: b.tool.collapsed,
    };
    const tool: ToolUseBlock = data.is_error
      ? { ...base, status: 'error', result: data.content, result_is_error: true }
      : { ...base, status: 'done', result: data.content, result_is_error: false };
    return { ...b, tool };
  });
}
