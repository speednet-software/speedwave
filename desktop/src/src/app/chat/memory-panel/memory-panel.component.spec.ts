import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MemoryPanelComponent, parseSections } from './memory-panel.component';

@Component({
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

/**
 * Query the drawer content in the CDK overlay container on document.body.
 * @param sel CSS selector to locate the element under document.
 */
function q(sel: string): HTMLElement | null {
  return document.querySelector(sel) as HTMLElement | null;
}

describe('MemoryPanelComponent', () => {
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
      fixture.detectChanges();
      expect(q('[data-testid="memory-panel"]')).toBeNull();
    });

    it('renders the drawer in the overlay container when open=true', () => {
      host.open = true;
      fixture.detectChanges();
      expect(q('[data-testid="memory-panel"]')).not.toBeNull();
    });

    it('detaches the overlay when open transitions back to false', () => {
      // Drives the child input directly (bypasses OnPush on the host's plain fields) to verify the
      // CDK overlay attaches/detaches in lockstep with `open`; destroys the shared host fixture first.
      fixture.destroy();
      const childFixture = TestBed.createComponent(MemoryPanelComponent);
      childFixture.componentRef.setInput('open', true);
      childFixture.detectChanges();
      TestBed.tick();
      expect(q('[data-testid="memory-panel"]')).not.toBeNull();

      childFixture.componentRef.setInput('open', false);
      childFixture.detectChanges();
      TestBed.tick();
      expect(q('[data-testid="memory-panel"]')).toBeNull();
      childFixture.destroy();
    });
  });

  describe('ARIA', () => {
    it('has role="complementary" and aria-label="Project memory"', () => {
      host.open = true;
      fixture.detectChanges();
      const panel = q('[data-testid="memory-panel"]');
      expect(panel).not.toBeNull();
      expect(panel!.getAttribute('role')).toBe('complementary');
      expect(panel!.getAttribute('aria-label')).toBe('Project memory');
    });

    it('close button has aria-label="Close memory panel"', () => {
      host.open = true;
      fixture.detectChanges();
      const btn = q('[data-testid="memory-panel-close"]');
      expect(btn).not.toBeNull();
      expect(btn!.getAttribute('aria-label')).toBe('Close memory panel');
    });
  });

  describe('section rendering', () => {
    it('renders parsed sections with mono kicker + dim body', () => {
      host.open = true;
      host.markdown = `# Memory\n\n## User\n\nPolish speaker. Terse explanations.\n\n## Project\n\nSpeedwave 2.0.\n\n## Feedback\n\nNever bypass git hooks.`;
      fixture.detectChanges();

      const user = q('[data-testid="memory-section-user"]');
      expect(user).not.toBeNull();
      expect(user!.textContent).toContain('user');
      expect(user!.textContent).toContain('Polish speaker');

      const project = q('[data-testid="memory-section-project"]');
      expect(project!.textContent).toContain('Speedwave 2.0.');

      const feedback = q('[data-testid="memory-section-feedback"]');
      expect(feedback!.textContent).toContain('Never bypass git hooks.');
    });

    it('shows the section count pill when sections are present', () => {
      host.open = true;
      host.markdown = `## User\n\nA\n\n## Project\n\nB\n\n## Feedback\n\nC`;
      fixture.detectChanges();
      const pill = q('[data-testid="memory-panel-count"]');
      expect(pill).not.toBeNull();
      expect(pill!.textContent!.trim()).toBe('3 entries');
    });

    it('renders raw markdown as plain text when no canonical sections are parsed', () => {
      host.open = true;
      host.markdown = '# Hello\n\nWorld';
      fixture.detectChanges();
      const body = q('[data-testid="memory-panel-body"]');
      expect(body).not.toBeNull();
      expect(q('app-text-block')).toBeNull();
      const fallback = q('[data-testid="memory-panel-fallback"]');
      expect(fallback).not.toBeNull();
      expect(fallback!.textContent).toContain('# Hello');
      expect(fallback!.textContent).toContain('World');
    });

    it('shows empty placeholder when markdown is empty string', () => {
      host.open = true;
      host.markdown = '';
      fixture.detectChanges();
      expect(q('[data-testid="memory-panel-empty"]')).not.toBeNull();
      expect(q('app-text-block')).toBeNull();
    });
  });

  describe('close event', () => {
    it('emits closed when close button clicked', () => {
      host.open = true;
      fixture.detectChanges();
      const btn = q('[data-testid="memory-panel-close"]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      btn!.click();
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

      const errorEl = q('[data-testid="memory-panel-error"]');
      expect(errorEl).not.toBeNull();
      expect(errorEl!.textContent).toContain('Failed to load memory');
      expect(q('app-text-block')).toBeNull();
      expect(q('[data-testid="memory-panel-empty"]')).toBeNull();
    });

    it('renders markdown (no error banner) when error is empty string', () => {
      host.open = true;
      host.markdown = '# Recovered';
      host.error = '';
      fixture.detectChanges();

      expect(q('[data-testid="memory-panel-error"]')).toBeNull();
      expect(q('app-text-block')).toBeNull();
      expect(q('[data-testid="memory-panel-fallback"]')).not.toBeNull();
      expect(q('[data-testid="memory-panel-fallback"]')!.textContent).toContain('# Recovered');
    });

    it('renders empty placeholder when both markdown and error are empty', () => {
      host.open = true;
      host.markdown = '';
      host.error = '';
      fixture.detectChanges();

      expect(q('[data-testid="memory-panel-error"]')).toBeNull();
      expect(q('[data-testid="memory-panel-empty"]')).not.toBeNull();
    });
  });

  describe('link safety (no markdown rendering)', () => {
    it('does not render anchors for relative markdown links (the white-screen regression)', () => {
      host.open = true;
      host.markdown =
        '- [feedback_no_hardcoded_paths.md](feedback_no_hardcoded_paths.md) — Never put absolute user paths in committed files';
      fixture.detectChanges();
      const body = q('[data-testid="memory-panel-body"]');
      expect(body).not.toBeNull();
      expect(body!.querySelector('a')).toBeNull();
      expect(body!.textContent).not.toContain('feedback_no_hardcoded_paths.md');
      expect(body!.textContent).toContain('Never put absolute user paths');
    });

    it('does not render anchors for absolute http links inside MEMORY.md', () => {
      host.open = true;
      host.markdown = 'See [docs](https://example.com/docs) for more.';
      fixture.detectChanges();
      const body = q('[data-testid="memory-panel-body"]');
      expect(body).not.toBeNull();
      expect(body!.querySelector('a')).toBeNull();
      expect(body!.textContent).toContain('See docs for more.');
      expect(body!.textContent).not.toContain('https://example.com');
    });

    it('strips pointer-style links in the unstructured fallback (no canonical headers)', () => {
      // No `## ...` headers — entries land in the fallback branch.
      host.open = true;
      host.markdown = [
        '- [foo entry](foo.md) — first description',
        '- [bar entry](bar.md) — second description',
      ].join('\n');
      fixture.detectChanges();
      const fallback = q('[data-testid="memory-panel-fallback"]');
      expect(fallback).not.toBeNull();
      expect(fallback!.querySelector('a')).toBeNull();
      expect(fallback!.textContent).toContain('first description');
      expect(fallback!.textContent).toContain('second description');
      expect(fallback!.textContent).not.toContain('foo.md');
      expect(fallback!.textContent).not.toContain('bar.md');
      expect(fallback!.textContent).not.toContain('[foo entry]');
      expect(fallback!.textContent).not.toContain('[bar entry]');
    });

    it('does not render anchors when MEMORY.md mixes canonical sections with link entries', () => {
      host.open = true;
      host.markdown = '## Feedback\n\n- [a.md](a.md) one\n- [b.md](b.md) two';
      fixture.detectChanges();
      const body = q('[data-testid="memory-panel-body"]');
      expect(body).not.toBeNull();
      expect(body!.querySelector('a')).toBeNull();
      expect(body!.textContent).not.toContain('[a.md](a.md)');
      expect(body!.textContent).not.toContain('[b.md](b.md)');
      expect(body!.textContent).toContain('one');
      expect(body!.textContent).toContain('two');
    });

    it('does not render anchors when MEMORY.md fallback contains a javascript: scheme', () => {
      host.open = true;
      host.markdown = '[click](javascript:alert(1))';
      fixture.detectChanges();
      const body = q('[data-testid="memory-panel-body"]');
      expect(body).not.toBeNull();
      expect(body!.querySelector('a')).toBeNull();
    });
  });
});

describe('parseSections', () => {
  it('returns empty array for empty markdown', () => {
    expect(parseSections('')).toEqual([]);
  });

  it('returns empty array when no canonical headers are present', () => {
    expect(parseSections('# Title\n\nNo subsections here.')).toEqual([]);
  });

  it('extracts each canonical section in document order', () => {
    const md = `## User\n\nU body.\n\n## Project\n\nP body.\n\n## Feedback\n\nF body.\n\n## Reference\n\nR body.`;
    const out = parseSections(md);
    expect(out.map((s) => s.id)).toEqual(['user', 'project', 'feedback', 'reference']);
    expect(out[0].body).toBe('U body.');
    expect(out[3].body).toBe('R body.');
  });

  it('drops sections whose body is empty after trimming', () => {
    const md = `## User\n\n## Project\n\nP body only.`;
    const out = parseSections(md);
    expect(out.map((s) => s.id)).toEqual(['project']);
  });

  it('preserves embedded markdown inside a section body', () => {
    const md = `## Feedback\n\n- bullet one\n- bullet two\n\nclosing line.`;
    const out = parseSections(md);
    expect(out).toHaveLength(1);
    expect(out[0].body).toContain('- bullet one');
    expect(out[0].body).toContain('closing line.');
  });

  it('strips pointer-style markdown links so only the description remains', () => {
    const md = [
      '## User',
      '',
      '- [foo entry](foo.md) — first description',
      '- [bar entry](bar.md) — second description',
    ].join('\n');
    const out = parseSections(md);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe(['- first description', '- second description'].join('\n'));
    expect(out[0].body).not.toContain('[');
    expect(out[0].body).not.toContain('foo.md');
    expect(out[0].body).not.toContain('bar.md');
  });

  it('handles em-dash, en-dash, and hyphen separators between link and description', () => {
    const md = [
      '## Feedback',
      '',
      '- [a](a.md) — em-dash desc',
      '- [b](b.md) – en-dash desc',
      '- [c](c.md) - hyphen desc',
    ].join('\n');
    const out = parseSections(md);
    expect(out[0].body).toBe(['- em-dash desc', '- en-dash desc', '- hyphen desc'].join('\n'));
  });

  it('keeps the bullet when a pointer entry has no description', () => {
    const md = '## Project\n\n- [orphan](orphan.md)';
    const out = parseSections(md);
    expect(out[0].body).toBe('-');
  });

  it('inlines bare markdown links inside a sentence with their visible text', () => {
    const md = '## Reference\n\nSee [the docs](https://example.com) for more.';
    const out = parseSections(md);
    expect(out[0].body).toBe('See the docs for more.');
  });

  it('passes through plain bullet lines unchanged when no links are present', () => {
    const md = '## User\n\n- plain note one\n- plain note two';
    const out = parseSections(md);
    expect(out[0].body).toBe('- plain note one\n- plain note two');
  });
});
