import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { ChatMessage, MessageBlock } from '../../models/chat';
import { TextBlockComponent } from '../blocks/text-block.component';
import { ThinkingBlockComponent } from '../blocks/thinking-block.component';
import { ToolBlockComponent } from '../blocks/tool-block.component';
import { ErrorBlockComponent } from '../blocks/error-block.component';
import { AskUserBlockComponent } from '../blocks/ask-user-block.component';
import { PermissionPromptComponent } from '../blocks/permission-prompt.component';
import { UserMessageComponent } from './user-message.component';
import { MessageActionsComponent } from './message-actions.component';
import { MessageMetadataComponent } from './message-metadata.component';

/**
 * Renders a single chat message in the terminal-minimal layout.
 *
 * - User messages → delegate to `<app-user-message>` (mono "user · time" meta
 *   line + plain content, no bubble).
 * - Assistant messages → mono "speedwave · time" meta line, then body blocks,
 *   then `<app-message-metadata>` (model · edited · tokens · cache · cost),
 *   then `<app-message-actions>` (copy / retry).
 */
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
    MessageActionsComponent,
    MessageMetadataComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex w-full flex-col items-stretch' },
  template: `
    @if (role() === 'user') {
      <article data-testid="chat-message" [attr.data-role]="role()">
        <app-user-message [blocks]="blocks()" [editedAt]="editedAt()" [timestamp]="timestamp()" />
      </article>
    } @else {
      <article data-testid="chat-message" [attr.data-role]="role()">
        <!-- Author + timestamp meta line removed: identity is conveyed by
             alignment (assistant on the left, user-bubble on the right) and
             the per-message metadata row at the bottom already shows model
             + tokens + cost; an explicit "speedwave · HH:MM" header was
             redundant. Streaming state is signalled by the trailing caret. -->
        <div class="text-[14px] leading-[1.7] text-[var(--ink)]">
          @for (block of blocks(); track $index) {
            @switch (block.type) {
              @case ('text') {
                <app-text-block [content]="block.content" [streaming]="streaming() && $last" />
              }
              @case ('thinking') {
                <app-thinking-block
                  [content]="block.content"
                  [collapsedDefault]="block.collapsed"
                />
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
          @if (streaming() && !lastBlockIsText()) {
            <span data-testid="cursor" class="caret ml-0.5" aria-hidden="true"></span>
          }
        </div>

        @if (!streaming() && entry()) {
          <app-message-metadata [entry]="entry()!" [precedingEdited]="precedingEdited()" />
        }

        @if (!streaming() && entry() && entryIndex() !== null) {
          <app-message-actions [entryIndex]="entryIndex()!" [isLast]="isLast()" />
        }
      </article>
    }
  `,
})
export class ChatMessageComponent {
  readonly blocks = input.required<readonly MessageBlock[]>();
  readonly role = input<'user' | 'assistant'>('assistant');
  readonly streaming = input(false);
  readonly editedAt = input<number | undefined>(undefined);
  readonly timestamp = input(0);
  readonly entryIndex = input<number | null>(null);
  readonly isLast = input(false);
  readonly entry = input<ChatMessage | undefined>(undefined);
  readonly precedingEdited = input(false);
  readonly questionAnswered = output<{ toolId: string; values: string[] }>();
  readonly permissionDecided = output<{
    blockIndex: number;
    decision: 'allow_once' | 'allow_always' | 'deny';
  }>();

  readonly lastBlockIsText = computed<boolean>(() => {
    const b = this.blocks();
    return b.length > 0 && b[b.length - 1].type === 'text';
  });

  readonly formattedTime = computed<string>(() => {
    const ts = this.timestamp();
    if (!ts) return '';
    const date = new Date(ts);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  });

  /**
   * Forwards a permission decision upstream tagged with the block's index.
   * @param blockIndex - Index of the permission_prompt block within this message.
   * @param decision - User's choice on the prompt.
   */
  onPermissionDecided(blockIndex: number, decision: 'allow_once' | 'allow_always' | 'deny'): void {
    this.permissionDecided.emit({ blockIndex, decision });
  }

  /**
   * Narrows a MessageBlock to its `tool_use` variant for the template.
   * @param block - Block to narrow.
   */
  asToolBlock(block: MessageBlock): Extract<MessageBlock, { type: 'tool_use' }> {
    return block as Extract<MessageBlock, { type: 'tool_use' }>;
  }

  /**
   * Narrows a MessageBlock to its `ask_user` variant for the template.
   * @param block - Block to narrow.
   */
  asAskUserBlock(block: MessageBlock): Extract<MessageBlock, { type: 'ask_user' }> {
    return block as Extract<MessageBlock, { type: 'ask_user' }>;
  }
}
