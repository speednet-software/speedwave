import { Injectable, inject } from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { TauriService } from './tauri.service';
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
  /** Completed messages (immutable — replaced on each change). */
  messages: ChatMessage[] = [];
  /** Blocks accumulating during the current streaming assistant turn. */
  currentBlocks: MessageBlock[] = [];
  isStreaming = false;
  /** Session cost/usage stats from the most recent result. */
  sessionStats: SessionStats | null = null;

  containerStatus: 'checking' | 'starting' | 'running' | 'error' = 'checking';
  containerError = '';
  /** The currently active project name, set during checkContainers. */
  activeProject: string | null = null;

  private unlisten: UnlistenFn | null = null;
  private listenerReady = false;
  private initialized = false;
  private tauri = inject(TauriService);

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

    this.messages = [
      ...this.messages,
      {
        role: 'user',
        blocks: [{ type: 'text', content: text }],
        timestamp: Date.now(),
      },
    ];
    this.isStreaming = true;
    this.currentBlocks = [];
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
          this.messages = [
            ...this.messages,
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
      this.messages = [
        ...this.messages,
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
    this.currentBlocks = this.currentBlocks.map((b) =>
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
      this.currentBlocks = this.currentBlocks.map((b) =>
        b.type === 'ask_user' && b.question.tool_id === toolUseId
          ? { ...b, question: { ...b.question, answered: false, selected_values: [] } }
          : b
      );
      this.currentBlocks = [
        ...this.currentBlocks,
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
        this.currentBlocks = appendOrCreateTextBlock(this.currentBlocks, chunk.data.content);
        break;

      case 'Thinking':
        this.isStreaming = true;
        this.currentBlocks = appendOrCreateThinkingBlock(this.currentBlocks, chunk.data.content);
        break;

      case 'ToolStart': {
        const newTool: ToolUseBlock = {
          tool_id: chunk.data.tool_id,
          tool_name: chunk.data.tool_name,
          input_json: '',
          status: 'running',
          collapsed: false,
        };
        this.currentBlocks = [...this.currentBlocks, { type: 'tool_use', tool: newTool }];
        break;
      }

      case 'ToolInputDelta':
        this.currentBlocks = updateToolInput(
          this.currentBlocks,
          chunk.data.tool_id,
          chunk.data.partial_json
        );
        break;

      case 'ToolResult':
        this.currentBlocks = completeToolBlock(this.currentBlocks, chunk.data);
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
        this.currentBlocks = [...this.currentBlocks, { type: 'ask_user', question: askBlock }];
        break;
      }

      case 'Result':
        if (this.currentBlocks.length > 0) {
          this.messages = [
            ...this.messages,
            { role: 'assistant', blocks: this.currentBlocks, timestamp: Date.now() },
          ];
          this.currentBlocks = [];
        }
        this.isStreaming = false;
        this.sessionStats = {
          session_id: chunk.data.session_id,
          cost_usd: chunk.data.cost_usd ?? 0,
          total_cost: chunk.data.total_cost ?? 0,
          usage: chunk.data.usage,
        };
        break;

      case 'Error':
        this.currentBlocks = [
          ...this.currentBlocks,
          { type: 'error', content: chunk.data.content },
        ];
        // Finalize as error turn
        this.messages = [
          ...this.messages,
          { role: 'assistant', blocks: this.currentBlocks, timestamp: Date.now() },
        ];
        this.currentBlocks = [];
        this.isStreaming = false;
        break;

      default:
        return; // unknown chunk type — no state change, no notification
    }
    this.notifyChange();
  }

  /** Clears all chat state to start a fresh conversation. */
  resetForNewConversation(): void {
    this.messages = [];
    this.currentBlocks = [];
    this.isStreaming = false;
    this.sessionStats = null;
    this.initialized = false;
    this.notifyChange();
  }

  /**
   * Replaces the current messages with a pre-loaded set (e.g. from a transcript).
   * @param msgs - The messages to load.
   */
  loadMessages(msgs: ChatMessage[]): void {
    this.messages = msgs;
    this.notifyChange();
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
      { type: 'thinking', content: last.content + content, collapsed: true },
    ];
  }
  return [...blocks, { type: 'thinking', content, collapsed: true }];
}

function updateToolInput(blocks: MessageBlock[], toolId: string, delta: string): MessageBlock[] {
  return blocks.map((b) =>
    b.type === 'tool_use' && b.tool.tool_id === toolId
      ? { ...b, tool: { ...b.tool, input_json: b.tool.input_json + delta } }
      : b
  );
}

function completeToolBlock(
  blocks: MessageBlock[],
  data: { tool_id: string; content: string; is_error: boolean }
): MessageBlock[] {
  return blocks.map((b) =>
    b.type === 'tool_use' && b.tool.tool_id === data.tool_id
      ? {
          ...b,
          tool: {
            ...b.tool,
            result: data.content,
            result_is_error: data.is_error,
            status: (data.is_error ? 'error' : 'done') as 'done' | 'error',
          },
        }
      : b
  );
}
