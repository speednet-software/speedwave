import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import type { MessageBlock } from '../../models/chat';
import { TextBlockComponent } from '../blocks/text-block.component';
import { ThinkingBlockComponent } from '../blocks/thinking-block.component';
import { ToolBlockComponent } from '../blocks/tool-block.component';
import { ErrorBlockComponent } from '../blocks/error-block.component';
import { AskUserBlockComponent } from '../blocks/ask-user-block.component';
import { PermissionPromptComponent } from '../blocks/permission-prompt.component';

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
    PermissionPromptComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex w-full',
    '[class.justify-end]': "role === 'user'",
    '[class.justify-start]': "role === 'assistant'",
  },
  template: `
    <div
      data-testid="chat-message"
      [attr.data-role]="role"
      class="w-fit max-w-[85%] px-4 py-3 rounded-lg leading-relaxed break-words"
      [class]="
        role === 'user'
          ? 'bg-sw-bg-navy text-sw-text'
          : 'bg-sw-bg-dark text-sw-text border border-sw-border'
      "
      [class.!border-sw-accent]="streaming"
    >
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
      @if (streaming) {
        <span data-testid="cursor" class="inline-block animate-blink text-sw-accent">&#x2588;</span>
      }
    </div>
  `,
})
export class ChatMessageComponent {
  @Input({ required: true }) blocks!: readonly MessageBlock[];
  @Input() role: 'user' | 'assistant' = 'assistant';
  @Input() streaming = false;
  @Output() questionAnswered = new EventEmitter<{ toolId: string; values: string[] }>();
  @Output() permissionDecided = new EventEmitter<{
    blockIndex: number;
    decision: 'allow_once' | 'allow_always' | 'deny';
  }>();

  /**
   * Forwards a permission decision upstream tagged with the block's index.
   * @param blockIndex - Index of the permission_prompt block in the parent's blocks array.
   * @param decision - The decision the user pressed (allow_once, allow_always, or deny).
   */
  onPermissionDecided(blockIndex: number, decision: 'allow_once' | 'allow_always' | 'deny'): void {
    this.permissionDecided.emit({ blockIndex, decision });
  }

  /**
   * Type guard cast: narrows a MessageBlock to its `tool_use` variant for the template.
   * @param block - The block to narrow.
   */
  asToolBlock(block: MessageBlock): Extract<MessageBlock, { type: 'tool_use' }> {
    return block as Extract<MessageBlock, { type: 'tool_use' }>;
  }

  /**
   * Type guard cast: narrows a MessageBlock to its `ask_user` variant for the template.
   * @param block - The block to narrow.
   */
  asAskUserBlock(block: MessageBlock): Extract<MessageBlock, { type: 'ask_user' }> {
    return block as Extract<MessageBlock, { type: 'ask_user' }>;
  }
}
