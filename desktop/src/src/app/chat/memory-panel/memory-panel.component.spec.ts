import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MemoryPanelComponent } from './memory-panel.component';

@Component({
  standalone: true,
  imports: [MemoryPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-memory-panel [open]="open" [markdown]="markdown" [error]="error" (closed)="onClosed()" />
  `,
})
class HostComponent {
  open = false;
  markdown = '';
  error = '';
  closedCount = 0;

  onClosed(): void {
    this.closedCount += 1;
  }
}

describe('MemoryPanelComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
  });

  describe('visibility', () => {
    it('renders nothing when open=false', () => {
      host.open = false;
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="memory-panel"]')).toBeNull();
    });

    it('renders the drawer when open=true', () => {
      host.open = true;
      fixture.detectChanges();
      const panel = fixture.nativeElement.querySelector('[data-testid="memory-panel"]');
      expect(panel).not.toBeNull();
    });
  });

  describe('ARIA', () => {
    it('has role="complementary" and aria-label="Project memory"', () => {
      host.open = true;
      fixture.detectChanges();
      const panel = fixture.nativeElement.querySelector('[data-testid="memory-panel"]');
      expect(panel.getAttribute('role')).toBe('complementary');
      expect(panel.getAttribute('aria-label')).toBe('Project memory');
    });

    it('close button has aria-label="Close memory panel"', () => {
      host.open = true;
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector('[data-testid="memory-panel-close"]');
      expect(btn.getAttribute('aria-label')).toBe('Close memory panel');
    });
  });

  describe('markdown rendering', () => {
    it('renders the markdown content via app-text-block when non-empty', () => {
      host.open = true;
      host.markdown = '# Hello\n\nWorld';
      fixture.detectChanges();
      const body = fixture.nativeElement.querySelector('[data-testid="memory-panel-body"]');
      expect(body.querySelector('app-text-block')).not.toBeNull();
      expect(body.textContent).toContain('Hello');
      expect(body.textContent).toContain('World');
    });

    it('shows empty placeholder when markdown is empty string', () => {
      host.open = true;
      host.markdown = '';
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="memory-panel-empty"]')
      ).not.toBeNull();
      expect(fixture.nativeElement.querySelector('app-text-block')).toBeNull();
    });
  });

  describe('close event', () => {
    it('emits closed when close button clicked', () => {
      host.open = true;
      fixture.detectChanges();
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="memory-panel-close"]'
      ) as HTMLButtonElement;
      btn.click();
      expect(host.closedCount).toBe(1);
    });

    it('does not emit closed while panel is open but untouched', () => {
      host.open = true;
      fixture.detectChanges();
      expect(host.closedCount).toBe(0);
    });
  });

  describe('error rendering', () => {
    it('shows the error banner and hides body content when error is set', () => {
      host.open = true;
      host.markdown = '# Should be hidden';
      host.error = 'Failed to load memory: disk failure';
      fixture.detectChanges();

      const errorEl = fixture.nativeElement.querySelector('[data-testid="memory-panel-error"]');
      expect(errorEl).not.toBeNull();
      expect(errorEl.textContent).toContain('Failed to load memory');
      expect(fixture.nativeElement.querySelector('app-text-block')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="memory-panel-empty"]')).toBeNull();
    });

    it('renders markdown (no error banner) when error is empty string', () => {
      host.open = true;
      host.markdown = '# Recovered';
      host.error = '';
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="memory-panel-error"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('app-text-block')).not.toBeNull();
    });

    it('renders empty placeholder when both markdown and error are empty', () => {
      host.open = true;
      host.markdown = '';
      host.error = '';
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('[data-testid="memory-panel-error"]')).toBeNull();
      expect(
        fixture.nativeElement.querySelector('[data-testid="memory-panel-empty"]')
      ).not.toBeNull();
    });
  });
});
