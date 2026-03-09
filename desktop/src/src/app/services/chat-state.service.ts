import { Injectable, inject } from '@angular/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { TauriService } from './tauri.service';

/** A single chat message exchanged between the user and the assistant. */
export interface ChatMessage {
  role: string;
  content: string;
  timestamp: number;
}

/** A chunk emitted by the Claude streaming subprocess. */
export interface StreamChunk {
  chunk_type: string;
  content: string;
}

/** Response shape for the list_projects Tauri command. */
export interface ProjectList {
  projects: { name: string; dir: string }[];
  active_project: string | null;
}

/** Singleton service that holds chat session state across navigation. */
@Injectable({ providedIn: 'root' })
export class ChatStateService {
  messages: ChatMessage[] = [];
  isStreaming = false;
  currentStream = '';

  containerStatus: 'checking' | 'starting' | 'running' | 'error' = 'checking';
  containerError = '';

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

    this.messages.push({ role: 'user', content: text, timestamp: Date.now() });
    this.isStreaming = true;
    this.currentStream = '';
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
          this.messages.push({
            role: 'assistant',
            content: `Failed to restart session: ${retryErr}`,
            timestamp: Date.now(),
          });
          this.notifyChange();
          return;
        }
      }
      this.isStreaming = false;
      this.messages.push({
        role: 'assistant',
        content: `Failed to send message: ${err}`,
        timestamp: Date.now(),
      });
      this.notifyChange();
    }
  }

  /**
   * Processes a streaming chunk from the Claude subprocess.
   * @param chunk - The stream chunk to handle.
   */
  handleStreamChunk(chunk: StreamChunk): void {
    switch (chunk.chunk_type) {
      case 'text':
        this.isStreaming = true;
        this.currentStream += chunk.content;
        break;
      case 'result':
        if (this.currentStream) {
          this.messages.push({
            role: 'assistant',
            content: this.currentStream,
            timestamp: Date.now(),
          });
          this.currentStream = '';
        } else if (chunk.content) {
          this.messages.push({
            role: 'assistant',
            content: chunk.content,
            timestamp: Date.now(),
          });
        }
        this.isStreaming = false;
        break;
      case 'error':
        this.messages.push({
          role: 'assistant',
          content: `Error: ${chunk.content}`,
          timestamp: Date.now(),
        });
        this.currentStream = '';
        this.isStreaming = false;
        break;
      case 'tool_use':
        this.currentStream += `\n\n_Using tool: ${chunk.content}_\n\n`;
        break;
    }
    this.notifyChange();
  }

  /** Clears all chat state to start a fresh conversation. */
  resetForNewConversation(): void {
    this.messages = [];
    this.isStreaming = false;
    this.currentStream = '';
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
    } catch {
      // Not running inside Tauri (dev mode) — ignore
    }
  }
}
