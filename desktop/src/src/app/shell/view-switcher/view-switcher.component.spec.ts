import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterModule } from '@angular/router';
import { ViewSwitcherComponent, type ViewSwitcherEntry } from './view-switcher.component';

@Component({
  standalone: true,
  imports: [ViewSwitcherComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-view-switcher [views]="views" [activeId]="activeId" (selected)="onSelected($event)" />
  `,
})
class HostComponent {
  views: readonly ViewSwitcherEntry[] = [];
  activeId = '';
  selections: string[] = [];

  onSelected(id: string): void {
    this.selections.push(id);
  }
}

const views: readonly ViewSwitcherEntry[] = [
  { id: 'chat', label: 'chat', route: '/chat' },
  { id: 'integrations', label: 'integrations', route: '/integrations' },
  { id: 'settings', label: 'settings', route: '/settings' },
];

describe('ViewSwitcherComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [
        HostComponent,
        RouterModule.forRoot([
          { path: 'chat', children: [] },
          { path: 'integrations', children: [] },
          { path: 'settings', children: [] },
        ]),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
  });

  describe('rendering', () => {
    it('renders all views with role="tab"', () => {
      host.views = views;
      host.activeId = 'chat';
      fixture.detectChanges();

      const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
      expect(tabs.length).toBe(3);
    });

    it('has role="tablist" on the container with aria-label="Views"', () => {
      host.views = views;
      host.activeId = 'chat';
      fixture.detectChanges();

      const el = fixture.nativeElement.querySelector('[data-testid="view-switcher"]');
      expect(el.getAttribute('role')).toBe('tablist');
      expect(el.getAttribute('aria-label')).toBe('Views');
    });

    it('renders nothing when views is empty', () => {
      host.views = [];
      host.activeId = '';
      fixture.detectChanges();
      const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
      expect(tabs.length).toBe(0);
    });

    it('renders label text for each entry', () => {
      host.views = views;
      host.activeId = 'chat';
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('chat');
      expect(fixture.nativeElement.textContent).toContain('integrations');
      expect(fixture.nativeElement.textContent).toContain('settings');
    });
  });

  describe('active state', () => {
    it('sets aria-selected="true" only on the active view', () => {
      host.views = views;
      host.activeId = 'integrations';
      fixture.detectChanges();

      const active = fixture.nativeElement.querySelector('[data-testid="nav-integrations"]');
      const inactiveChat = fixture.nativeElement.querySelector('[data-testid="nav-chat"]');
      expect(active.getAttribute('aria-selected')).toBe('true');
      expect(inactiveChat.getAttribute('aria-selected')).toBe('false');
    });

    it('no active tab when activeId does not match any view', () => {
      host.views = views;
      host.activeId = 'nowhere';
      fixture.detectChanges();

      const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
      for (const tab of tabs) {
        expect(tab.getAttribute('aria-selected')).toBe('false');
      }
    });
  });

  describe('click emits', () => {
    /**
     * Dispatches a click that preventDefault()s itself so Angular's RouterLink
     * does not schedule an async navigation — that navigation would attempt to
     * resolve after the test's injector has been destroyed and raise NG0205.
     * @param el - The anchor element to click.
     */
    function clickWithoutNavigation(el: Element): void {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      event.preventDefault();
      el.dispatchEvent(event);
    }

    it('emits selected with the tab id on click', async () => {
      host.views = views;
      host.activeId = 'chat';
      fixture.detectChanges();

      const tab = fixture.nativeElement.querySelector(
        '[data-testid="nav-integrations"]'
      ) as Element;
      clickWithoutNavigation(tab);
      await fixture.whenStable();
      expect(host.selections).toEqual(['integrations']);
    });

    it('emits selected for each click', async () => {
      host.views = views;
      host.activeId = 'chat';
      fixture.detectChanges();

      clickWithoutNavigation(
        fixture.nativeElement.querySelector('[data-testid="nav-chat"]') as Element
      );
      clickWithoutNavigation(
        fixture.nativeElement.querySelector('[data-testid="nav-settings"]') as Element
      );
      await fixture.whenStable();
      expect(host.selections).toEqual(['chat', 'settings']);
    });
  });
});
