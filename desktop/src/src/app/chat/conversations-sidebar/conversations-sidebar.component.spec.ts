import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
      (resumeConversation)="onResume($event)"
    />
  `,
})
class HostComponent {
  open = true;
  conversations: readonly ConversationSummary[] = [];
  currentSessionId: string | null = null;
  closedCount = 0;
  resumedPayload: ConversationSummary | null = null;

  onClosed(): void {
    this.closedCount += 1;
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

/**
 * Query the drawer content rendered into the CDK overlay container.
 * The component renders via CDK Overlay portal attached to `document.body`,
 * not inside the host fixture, so we query the global document.
 * @param sel CSS selector to locate the element under document.
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
      // Drive the child input directly to bypass OnPush propagation issues
      // when mutating the host wrapper's plain fields. Verifies that the
      // CDK overlay portal attaches/detaches in lockstep with the open input.
      // The shared host fixture defaults to open=true, so destroy it first to
      // avoid having two drawers in the overlay container at the same time.
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
      // The drawer now formats timestamps as short relative labels
      // (e.g. "2m", "1h", "3d") and uses "—" for missing values.
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
      // Row click resumes directly (single primary action), so the test-id is
      // `conversation-resume-<sid>` rather than the legacy `view-<sid>`.
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
});
