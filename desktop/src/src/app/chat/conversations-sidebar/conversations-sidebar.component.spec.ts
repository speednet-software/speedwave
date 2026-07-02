import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  ConversationsSidebarComponent,
  scrollActiveRowIntoView,
} from './conversations-sidebar.component';
import type { ConversationSummary } from '../../models/chat';

@Component({
  standalone: true,
  imports: [ConversationsSidebarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-conversations-sidebar
      [open]="open"
      [conversations]="conversations"
      [currentSessionId]="currentSessionId"
      (closed)="onClosed()"
      (resumeConversation)="onResume($event)"
      (deleteConversation)="onDelete($event)"
    />
  `,
})
class HostComponent {
  open = true;
  conversations: readonly ConversationSummary[] = [];
  currentSessionId: string | null = null;
  closedCount = 0;
  resumedPayload: ConversationSummary | null = null;
  deletedPayload: ConversationSummary | null = null;

  onClosed(): void {
    this.closedCount += 1;
  }
  onResume(payload: ConversationSummary): void {
    this.resumedPayload = payload;
  }
  onDelete(payload: ConversationSummary): void {
    this.deletedPayload = payload;
  }
}

const sample: readonly ConversationSummary[] = [
  {
    session_id: 's1',
    preview: 'Refactoring container runtime',
    timestamp: '2m',
    message_count: 14,
  },
  { session_id: 's2', preview: 'MCP plugin signing', timestamp: '1h', message_count: 8 },
  { session_id: 's3', preview: '', timestamp: null, message_count: 0 },
];

/**
 * Query the CDK overlay portal under document.body.
 * @param sel - CSS selector to locate the element under document.
 */
function q(sel: string): HTMLElement | null {
  return document.querySelector(sel) as HTMLElement | null;
}

describe('ConversationsSidebarComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
  });

  afterEach(() => {
    // Tear down the overlay so each test starts with a clean container.
    host.open = false;
    fixture.detectChanges();
    fixture.destroy();
  });

  describe('visibility', () => {
    it('renders no drawer DOM when open=false', () => {
      host.open = false;
      host.conversations = sample;
      fixture.detectChanges();
      expect(q('[data-testid="conversations-sidebar"]')).toBeNull();
    });

    it('renders the drawer in the overlay container when open=true', () => {
      host.conversations = sample;
      fixture.detectChanges();
      expect(q('[data-testid="conversations-sidebar"]')).not.toBeNull();
    });

    it('detaches the overlay when open transitions back to false', () => {
      // Destroy the shared open=true fixture to avoid two drawers in the overlay.
      fixture.destroy();
      const childFixture = TestBed.createComponent(ConversationsSidebarComponent);
      childFixture.componentRef.setInput('conversations', sample);
      childFixture.componentRef.setInput('open', true);
      childFixture.detectChanges();
      TestBed.tick();
      expect(q('[data-testid="conversations-sidebar"]')).not.toBeNull();

      childFixture.componentRef.setInput('open', false);
      childFixture.detectChanges();
      TestBed.tick();
      expect(q('[data-testid="conversations-sidebar"]')).toBeNull();
      childFixture.destroy();
    });
  });

  describe('ARIA', () => {
    it('has role="navigation" and aria-label="Conversations"', () => {
      host.conversations = sample;
      fixture.detectChanges();
      const el = q('[data-testid="conversations-sidebar"]');
      expect(el).not.toBeNull();
      expect(el!.getAttribute('role')).toBe('navigation');
      expect(el!.getAttribute('aria-label')).toBe('Conversations');
    });
  });

  describe('empty state', () => {
    it('shows placeholder when conversations is empty', () => {
      host.conversations = [];
      fixture.detectChanges();
      const drawer = q('[data-testid="conversations-sidebar"]');
      expect(drawer).not.toBeNull();
      expect(drawer!.textContent).toContain('no conversations yet');
      expect(q('[data-testid="conversations-sidebar-row"]')).toBeNull();
    });
  });

  describe('list rendering', () => {
    it('renders one row per conversation', () => {
      host.conversations = sample;
      fixture.detectChanges();
      const rows = document.querySelectorAll('[data-testid="conversations-sidebar-row"]');
      expect(rows.length).toBe(3);
    });

    it('renders preview text and count', () => {
      host.conversations = sample;
      fixture.detectChanges();
      const drawer = q('[data-testid="conversations-sidebar"]')!;
      expect(drawer.textContent).toContain('Refactoring container runtime');
      expect(drawer.textContent).toContain('14 · 2m');
    });

    it('falls back to "untitled" when preview is empty', () => {
      host.conversations = sample;
      fixture.detectChanges();
      const drawer = q('[data-testid="conversations-sidebar"]')!;
      expect(drawer.textContent).toContain('untitled');
    });

    it('falls back to a dash when timestamp is null', () => {
      host.conversations = sample;
      fixture.detectChanges();
      const drawer = q('[data-testid="conversations-sidebar"]')!;
      expect(drawer.textContent).toContain('0 · —');
    });
  });

  describe('active highlight', () => {
    it('applies aria-current="true" on the active row', () => {
      host.conversations = sample;
      host.currentSessionId = 's2';
      fixture.detectChanges();
      const active = q('[data-testid="conversation-resume-s2"]');
      expect(active).not.toBeNull();
      expect(active!.getAttribute('aria-current')).toBe('true');
    });

    it('no aria-current when no match', () => {
      host.conversations = sample;
      host.currentSessionId = 'unknown';
      fixture.detectChanges();
      const els = document.querySelectorAll('[aria-current="true"]');
      expect(els.length).toBe(0);
    });

    it('marks the active row with data-active so it can be scrolled into view', () => {
      host.conversations = sample;
      host.currentSessionId = 's3';
      fixture.detectChanges();
      const actives = document.querySelectorAll('[data-active="true"]');
      expect(actives.length).toBe(1);
      // The data-active row is the one wrapping the active session's resume button.
      expect(actives[0].querySelector('[data-testid="conversation-resume-s3"]')).not.toBeNull();
    });

    it('sets no data-active row when nothing is active', () => {
      host.conversations = sample;
      host.currentSessionId = null;
      fixture.detectChanges();
      expect(document.querySelectorAll('[data-active="true"]').length).toBe(0);
    });
  });

  describe('scrollActiveRowIntoView', () => {
    it('scrolls the active row to the top of the list (block: start)', () => {
      const root = document.createElement('div');
      const other = document.createElement('div');
      const active = document.createElement('div');
      active.setAttribute('data-active', 'true');
      root.append(other, active);
      let calledWith: ScrollIntoViewOptions | undefined;
      active.scrollIntoView = (arg?: boolean | ScrollIntoViewOptions) => {
        calledWith = arg as ScrollIntoViewOptions;
      };
      let otherScrolled = false;
      other.scrollIntoView = () => {
        otherScrolled = true;
      };

      scrollActiveRowIntoView(root);

      expect(calledWith).toEqual({ block: 'start' });
      expect(otherScrolled).toBe(false);
    });

    it('is a no-op when no row is active', () => {
      const root = document.createElement('div');
      const row = document.createElement('div');
      let scrolled = false;
      row.scrollIntoView = () => {
        scrolled = true;
      };
      root.append(row);

      expect(() => scrollActiveRowIntoView(root)).not.toThrow();
      expect(scrolled).toBe(false);
    });
  });

  describe('event outputs', () => {
    it('emits closed when close button clicked', () => {
      host.conversations = sample;
      fixture.detectChanges();
      const btn = q('[data-testid="conversations-sidebar-close"]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      btn!.click();
      expect(host.closedCount).toBe(1);
    });

    it('emits resumeConversation when any row is clicked (primary action)', () => {
      host.conversations = sample;
      fixture.detectChanges();
      const row = q('[data-testid="conversation-resume-s1"]') as HTMLButtonElement | null;
      expect(row).not.toBeNull();
      row!.click();
      expect(host.resumedPayload?.session_id).toBe('s1');
    });
  });

  describe('delete', () => {
    it('shows the trash button for every row', () => {
      host.conversations = sample;
      fixture.detectChanges();
      expect(q('[data-testid="conversation-delete-s1"]')).not.toBeNull();
      expect(q('[data-testid="conversation-delete-s2"]')).not.toBeNull();
      expect(q('[data-testid="conversation-delete-s3"]')).not.toBeNull();
    });

    it('trash click swaps the row into a confirm prompt; does not emit yet', () => {
      host.conversations = sample;
      fixture.detectChanges();
      (q('[data-testid="conversation-delete-s2"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(q('[data-testid="conversation-confirm-s2"]')).not.toBeNull();
      expect(q('[data-testid="conversation-resume-s2"]')).toBeNull();
      expect(host.deletedPayload).toBeNull();
    });

    it('confirm button emits deleteConversation with the row payload', () => {
      host.conversations = sample;
      fixture.detectChanges();
      (q('[data-testid="conversation-delete-s2"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      (q('[data-testid="conversation-confirm-yes-s2"]') as HTMLButtonElement).click();
      expect(host.deletedPayload?.session_id).toBe('s2');
    });

    it('cancel button reverts to the row without emitting', () => {
      host.conversations = sample;
      fixture.detectChanges();
      (q('[data-testid="conversation-delete-s2"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      (q('[data-testid="conversation-confirm-no-s2"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(q('[data-testid="conversation-confirm-s2"]')).toBeNull();
      expect(q('[data-testid="conversation-resume-s2"]')).not.toBeNull();
      expect(host.deletedPayload).toBeNull();
    });

    it('only one row can be in confirm state at a time', () => {
      host.conversations = sample;
      fixture.detectChanges();
      (q('[data-testid="conversation-delete-s1"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      (q('[data-testid="conversation-delete-s2"]') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(q('[data-testid="conversation-confirm-s1"]')).toBeNull();
      expect(q('[data-testid="conversation-confirm-s2"]')).not.toBeNull();
    });

    it('clears the confirm state when the drawer is closed and reopened', () => {
      fixture.destroy();
      const childFixture = TestBed.createComponent(ConversationsSidebarComponent);
      childFixture.componentRef.setInput('conversations', sample);
      childFixture.componentRef.setInput('open', true);
      childFixture.detectChanges();
      TestBed.tick();
      (q('[data-testid="conversation-delete-s2"]') as HTMLButtonElement).click();
      childFixture.detectChanges();
      expect(q('[data-testid="conversation-confirm-s2"]')).not.toBeNull();

      childFixture.componentRef.setInput('open', false);
      childFixture.detectChanges();
      TestBed.tick();
      childFixture.componentRef.setInput('open', true);
      childFixture.detectChanges();
      TestBed.tick();
      expect(q('[data-testid="conversation-confirm-s2"]')).toBeNull();
      expect(q('[data-testid="conversation-resume-s2"]')).not.toBeNull();
      childFixture.destroy();
    });
  });
});
