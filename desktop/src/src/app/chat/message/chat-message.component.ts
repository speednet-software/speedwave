import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import type { MessageBlock } from '../../models/chat';
import { TextBlockComponent } from '../blocks/text-block.component';
import { ThinkingBlockComponent } from '../blocks/thinking-block.component';
import { ToolBlockComponent } from '../blocks/tool-block.component';
import { ErrorBlockComponent } from '../blocks/error-block.component';
import { AskUserBlockComponent } from '../blocks/ask-user-block.component';

/** Renders a single chat message as a sequence of typed blocks (text, tool, thinking, etc.). */
@Component({
  selector: 'app-chat-message',
  standalone: true,
  imports: [
    TextBlockComponent,
    ThinkingBlockComponent,
    ToolBlockComponent,
    ErrorBlockComponent,
    AskUserBlockComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chat-message" [class]="role" [class.streaming]="streaming">
      @for (block of blocks; track $index) {
        @switch (block.type) {
          @case ('text') {
            <app-text-block [content]="block.content" />
          }
          @case ('thinking') {
            <app-thinking-block [content]="block.content" [collapsed]="block.collapsed" />
          }
          @case ('tool_use') {
            <app-tool-block [tool]="asToolBlock(block).tool" />
          }
          @case ('ask_user') {
            <app-ask-user-block
              [question]="asAskUserBlock(block).question"
              (answered)="onAnswered(asAskUserBlock(block).question.tool_id, $event)"
            />
          }
          @case ('error') {
            <app-error-block [content]="block.content" />
          }
        }
      }
      @if (streaming) {
        <span class="cursor">&#x2588;</span>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .chat-message {
      max-width: 85%;
      padding: 12px 16px;
      border-radius: 8px;
      line-height: 1.5;
      word-wrap: break-word;
    }
    .chat-message.user {
      align-self: flex-end;
      background: #0f3460;
      color: #e0e0e0;
    }
    .chat-message.assistant {
      align-self: flex-start;
      background: #16213e;
      color: #e0e0e0;
      border: 1px solid #0f3460;
    }
    .chat-message.streaming {
      border-color: #e94560;
    }
    .cursor {
      display: inline-block;
      animation: blink 1s step-end infinite;
      color: #e94560;
    }
    @keyframes blink {
      50% {
        opacity: 0;
      }
    }
  `,
})
export class ChatMessageComponent {
  @Input({ required: true }) blocks!: readonly MessageBlock[];
  @Input() role: 'user' | 'assistant' = 'assistant';
  @Input() streaming = false;
  @Output() questionAnswered = new EventEmitter<{ toolId: string; values: string[] }>();

  /**
   * Narrows to tool_use.
   * @param block - The message block to narrow.
   */
  asToolBlock(block: MessageBlock): Extract<MessageBlock, { type: 'tool_use' }> {
    return block as Extract<MessageBlock, { type: 'tool_use' }>;
  }

  /**
   * Narrows to ask_user.
   * @param block - The message block to narrow.
   */
  asAskUserBlock(block: MessageBlock): Extract<MessageBlock, { type: 'ask_user' }> {
    return block as Extract<MessageBlock, { type: 'ask_user' }>;
  }

  /**
   * Emits a question-answered event upstream.
   * @param toolId - The tool ID of the AskUserQuestion block.
   * @param values - The selected answer values.
   */
  onAnswered(toolId: string, values: string[]): void {
    this.questionAnswered.emit({ toolId, values });
  }
}
