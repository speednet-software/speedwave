import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ConversationsSidebarComponent } from './conversations-sidebar.component';
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
      (newConversation)="onNew()"
      (resumeConversation)="onResume($event)"
    />
  `,
})
class HostComponent {
  open = true;
  conversations: readonly ConversationSummary[] = [];
  currentSessionId: string | null = null;
  closedCount = 0;
  newCount = 0;
  resumedPayload: ConversationSummary | null = null;

  onClosed(): void {
    this.closedCount += 1;
  }
  onNew(): void {
    this.newCount += 1;
  }
  onResume(payload: ConversationSummary): void {
    this.resumedPayload = payload;
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

describe('ConversationsSidebarComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
  });

  describe('visibility', () => {
    it('marks the drawer aria-hidden + inert when open=false', () => {
      host.open = false;
      host.conversations = sample;
      fixture.detectChanges();
      const drawer = fixture.nativeElement.querySelector('[data-testid="conversations-sidebar"]');
      expect(drawer).not.toBeNull();
      expect(drawer.getAttribute('aria-hidden')).toBe('true');
      expect(drawer.hasAttribute('inert')).toBe(true);
    });

    it('renders drawer with no aria-hidden / inert when open=true', () => {
      host.conversations = sample;
      fixture.detectChanges();
      const drawer = fixture.nativeElement.querySelector('[data-testid="conversations-sidebar"]');
      expect(drawer).not.toBeNull();
      expect(drawer.getAttribute('aria-hidden')).toBeNull();
      expect(drawer.hasAttribute('inert')).toBe(false);
    });

    it('toggles body.sidebar-drawer-open with the open input', () => {
      // Drive the child input directly to bypass OnPush propagation issues
      // when mutating the host wrapper's plain fields. The effect registered
      // in the child's constructor is what we're verifying — it must
      // synchronize the global body class with the open signal.
      const childFixture = TestBed.createComponent(ConversationsSidebarComponent);
      childFixture.componentRef.setInput('conversations', sample);
      childFixture.componentRef.setInput('open', true);
      childFixture.detectChanges();
      TestBed.tick();
      expect(document.body.classList.contains('sidebar-drawer-open')).toBe(true);

      childFixture.componentRef.setInput('open', false);
      childFixture.detectChanges();
      TestBed.tick();
      expect(document.body.classList.contains('sidebar-drawer-open')).toBe(false);
    });
  });

  describe('ARIA', () => {
    it('has role="navigation" and aria-label="Conversations"', () => {
      host.conversations = sample;
      fixture.detectChanges();
      const el = fixture.nativeElement.querySelector('[data-testid="conversations-sidebar"]');
      expect(el.getAttribute('role')).toBe('navigation');
      expect(el.getAttribute('aria-label')).toBe('Conversations');
    });
  });

  describe('empty state', () => {
    it('shows placeholder when conversations is empty', () => {
      host.conversations = [];
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('no conversations yet');
      expect(
        fixture.nativeElement.querySelector('[data-testid="conversations-sidebar-row"]')
      ).toBeNull();
    });
  });

  describe('list rendering', () => {
    it('renders one row per conversation', () => {
      host.conversations = sample;
      fixture.detectChanges();
      const rows = fixture.nativeElement.querySelectorAll(
        '[data-testid="conversations-sidebar-row"]'
      );
      expect(rows.length).toBe(3);
    });

    it('renders preview text and count', () => {
      host.conversations = sample;
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('Refactoring container runtime');
      expect(fixture.nativeElement.textContent).toContain('14 · 2m');
    });

    it('falls back to "untitled" when preview is empty', () => {
      host.conversations = sample;
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('untitled');
    });

    it('falls back to a dash when timestamp is null', () => {
      // The drawer now formats timestamps as short relative labels
      // (e.g. "2m", "1h", "3d") and uses "—" for missing values.
      host.conversations = sample;
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('0 · —');
    });
  });

  describe('active highlight', () => {
    it('applies aria-current="true" on the active row', () => {
      host.conversations = sample;
      host.currentSessionId = 's2';
      fixture.detectChanges();
      // Row click resumes directly (single primary action), so the test-id is
      // `conversation-resume-<sid>` rather than the legacy `view-<sid>`.
      const active = fixture.nativeElement.querySelector('[data-testid="conversation-resume-s2"]');
      expect(active.getAttribute('aria-current')).toBe('true');
    });

    it('no aria-current when no match', () => {
      host.conversations = sample;
      host.currentSessionId = 'unknown';
      fixture.detectChanges();
      const els = fixture.nativeElement.querySelectorAll('[aria-current="true"]');
      expect(els.length).toBe(0);
    });
  });

  describe('event outputs', () => {
    it('emits closed when close button clicked', () => {
      host.conversations = sample;
      fixture.detectChanges();
      (
        fixture.nativeElement.querySelector(
          '[data-testid="conversations-sidebar-close"]'
        ) as HTMLButtonElement
      ).click();
      expect(host.closedCount).toBe(1);
    });

    it('emits newConversation when + new clicked', () => {
      host.conversations = sample;
      fixture.detectChanges();
      (
        fixture.nativeElement.querySelector(
          '[data-testid="conversations-sidebar-new"]'
        ) as HTMLButtonElement
      ).click();
      expect(host.newCount).toBe(1);
    });

    it('emits resumeConversation when any row is clicked (primary action)', () => {
      host.conversations = sample;
      fixture.detectChanges();
      (
        fixture.nativeElement.querySelector(
          '[data-testid="conversation-resume-s1"]'
        ) as HTMLButtonElement
      ).click();
      expect(host.resumedPayload?.session_id).toBe('s1');
    });
  });
});
