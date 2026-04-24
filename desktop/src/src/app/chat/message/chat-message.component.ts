import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import type { MessageBlock } from '../../models/chat';
import { TextBlockComponent } from '../blocks/text-block.component';
import { ThinkingBlockComponent } from '../blocks/thinking-block.component';
import { ToolBlockComponent } from '../blocks/tool-block.component';
import { ErrorBlockComponent } from '../blocks/error-block.component';
import { AskUserBlockComponent } from '../blocks/ask-user-block.component';
import { PermissionPromptComponent } from '../blocks/permission-prompt.component';
import { UserMessageComponent } from './user-message.component';

@Component({
  selector: 'app-chat-message',
  imports: [
    TextBlockComponent,
    ThinkingBlockComponent,
    ToolBlockComponent,
    ErrorBlockComponent,
    AskUserBlockComponent,
    PermissionPromptComponent,
    UserMessageComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex w-full',
    '[class.justify-end]': "role === 'user'",
    '[class.justify-start]': "role === 'assistant'",
  },
  template: `
    @if (role === 'user') {
      <div data-testid="chat-message" [attr.data-role]="role">
        <app-user-message [blocks]="blocks" [editedAt]="editedAt" [timestamp]="timestamp" />
      </div>
    } @else {
      <div
        data-testid="chat-message"
        [attr.data-role]="role"
        class="max-w-[85%] px-4 py-3 rounded-lg leading-relaxed break-words self-start bg-sw-bg-dark text-sw-text border border-sw-border"
        [class.!border-sw-accent]="streaming"
      >
        @for (block of blocks; track $index) {
          @switch (block.type) {
            @case ('text') {
              <app-text-block [content]="block.content" [streaming]="streaming && $last" />
            }
            @case ('thinking') {
              <app-thinking-block [content]="block.content" [collapsedDefault]="block.collapsed" />
            }
            @case ('tool_use') {
              <app-tool-block [tool]="asToolBlock(block).tool" />
            }
            @case ('ask_user') {
              <app-ask-user-block
                [question]="asAskUserBlock(block).question"
                (answered)="questionAnswered.emit($event)"
              />
            }
            @case ('error') {
              <app-error-block [content]="block.content" [kind]="block.kind ?? 'generic'" />
            }
            @case ('permission_prompt') {
              <app-permission-prompt
                [command]="block.command"
                [description]="block.description ?? ''"
                (decided)="onPermissionDecided($index, $event)"
              />
            }
          }
        }
        @if (streaming && !lastBlockIsText) {
          <span data-testid="cursor" class="inline-block animate-blink text-sw-accent"
            >&#x2588;</span
          >
        }
      </div>
    }
  `,
})
export class ChatMessageComponent {
  @Input({ required: true }) blocks!: readonly MessageBlock[];
  @Input() role: 'user' | 'assistant' = 'assistant';
  @Input() streaming = false;
  @Input() editedAt: number | undefined = undefined;
  @Input() timestamp = 0;
  @Output() questionAnswered = new EventEmitter<{ toolId: string; values: string[] }>();
  @Output() permissionDecided = new EventEmitter<{
    blockIndex: number;
    decision: 'allow_once' | 'allow_always' | 'deny';
  }>();

  /** Suppresses the block-level cursor when the last block renders its own streaming caret. */
  get lastBlockIsText(): boolean {
    return this.blocks.length > 0 && this.blocks[this.blocks.length - 1].type === 'text';
  }

  /** Forwards a permission decision upstream tagged with the block's index. */
  onPermissionDecided(blockIndex: number, decision: 'allow_once' | 'allow_always' | 'deny'): void {
    this.permissionDecided.emit({ blockIndex, decision });
  }

  /** Narrows a MessageBlock to its `tool_use` variant for the template. */
  asToolBlock(block: MessageBlock): Extract<MessageBlock, { type: 'tool_use' }> {
    return block as Extract<MessageBlock, { type: 'tool_use' }>;
  }

  /** Narrows a MessageBlock to its `ask_user` variant for the template. */
  asAskUserBlock(block: MessageBlock): Extract<MessageBlock, { type: 'ask_user' }> {
    return block as Extract<MessageBlock, { type: 'ask_user' }>;
  }
}
