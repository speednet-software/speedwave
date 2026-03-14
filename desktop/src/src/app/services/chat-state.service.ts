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
} from '../models/chat';

// Re-export types consumed by components
export type {
  ChatMessage,
  MessageBlock,
  StreamChunk,
  ProjectList,
  SessionStats,
  AskUserQuestionBlock,
};

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

  containerStatus: 'checking' | 'starting' | 'switching' | 'running' | 'error' = 'checking';
  containerError = '';
  /** The currently active project name, set during checkContainers. */
  activeProject: string | null = null;

  private unlisten: UnlistenFn | null = null;
  private listenerReady = false;
  private initialized = false;
  private tauri = inject(TauriService);
  private projectState = inject(ProjectStateService);
  private unsubProjectChange: (() => void) | null = null;
  private unsubProjectSettled: (() => void) | null = null;

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

  /** Ensures the stream listener and container check run exactly once. */
  async init(): Promise<void> {
    if (!this.listenerReady) {
      this.listenerReady = true;
      await this.setupStreamListener();
      this.setupProjectStateListeners();
    }
    if (!this.initialized) {
      this.initialized = true;
      await this.checkContainers();
    }
  }

  /** Verifies that project containers are running and starts them if needed. */
  async checkContainers(): Promise<void> {
    this.containerStatus = 'checking';
    this.containerError = '';
    this.notifyChange();

    try {
      const result = await this.tauri.invoke<ProjectList>('list_projects');
      const project = result.active_project;
      this.activeProject = project;
      if (!project) {
        this.containerStatus = 'error';
        this.containerError = 'No active project selected. Please select a project first.';
        this.notifyChange();
        return;
      }

      const running = await this.tauri.invoke<boolean>('check_containers_running', { project });
      if (!running) {
        this.containerStatus = 'starting';
        this.notifyChange();
        await this.tauri.invoke('start_containers', { project });
      }

      await this.tauri.invoke('start_chat', { project });
      this.containerStatus = 'running';
    } catch (err) {
      this.containerStatus = 'error';
      this.containerError = String(err);
    }
    this.notifyChange();
  }

  /**
   * Sends a user message to Claude via the backend.
   * @param text - The message text to send.
   */
  async sendMessage(text: string): Promise<void> {
    if (!text || this.isStreaming) return;

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
          const result = await this.tauri.invoke<ProjectList>('list_projects');
          if (result.active_project) {
            await this.tauri.invoke('start_chat', { project: result.active_project });
            await this.tauri.invoke('send_message', { message: text });
            return;
          }
        } catch (retryErr) {
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

      case 'Result':
        if (this._currentBlocks.length > 0) {
          this._messages = [
            ...this._messages,
            { role: 'assistant', blocks: [...this._currentBlocks], timestamp: Date.now() },
          ];
          this._currentBlocks = [];
        }
        this.isStreaming = false;
        this._sessionStats = {
          session_id: chunk.data.session_id,
          cost_usd: chunk.data.cost_usd ?? 0,
          total_cost: chunk.data.total_cost ?? 0,
          usage: chunk.data.usage,
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
    this._messages = [];
    this._currentBlocks = [];
    this.isStreaming = false;
    this._sessionStats = null;
    this.initialized = false;
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
   * On settled: syncs local state with backend reality (chat already started by backend).
   */
  private setupProjectStateListeners(): void {
    this.unsubProjectChange = this.projectState.onChange(() => {
      if (this.projectState.status === 'switching') {
        this._messages = [];
        this._currentBlocks = [];
        this.isStreaming = false;
        this._sessionStats = null;
        this.containerStatus = 'switching';
        this.containerError = '';
        this.notifyChange();
      }
    });

    this.unsubProjectSettled = this.projectState.onProjectSettled(() => {
      const project = this.projectState.activeProject;
      this.activeProject = project;
      this.containerStatus = project ? 'running' : 'error';
      this.containerError = this.projectState.error;
      this.notifyChange();
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
        this.containerStatus = 'error';
        this.containerError = `Stream listener failed: ${err}`;
        this.notifyChange();
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
