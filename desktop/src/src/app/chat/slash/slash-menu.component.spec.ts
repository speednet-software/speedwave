import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SlashMenuComponent } from './slash-menu.component';
import { SlashService, type SlashCommand, type DiscoverySource } from './slash.service';

/** Stub SlashService with writable signals so tests can drive the component. */
class FakeSlashService {
  commands = signal<readonly SlashCommand[]>([]);
  discovering = signal(false);
  source = signal<DiscoverySource | null>(null);
  error = signal<string | null>(null);
  isLoadingEmpty = () => this.discovering() && this.commands().length === 0;
  refresh = vi.fn();
  invalidate = vi.fn();
}

describe('SlashMenuComponent', () => {
  let fixture: ComponentFixture<SlashMenuComponent>;
  let component: SlashMenuComponent;
  let service: FakeSlashService;

  const cmd = (
    name: string,
    kind: SlashCommand['kind'] = 'Command',
    description: string | null = null,
    plugin: string | null = null,
    argument_hint: string | null = null
  ): SlashCommand => ({ name, description, argument_hint, kind, plugin });

  beforeEach(() => {
    service = new FakeSlashService();
    TestBed.configureTestingModule({
      imports: [SlashMenuComponent],
      providers: [{ provide: SlashService, useValue: service }],
    });
    fixture = TestBed.createComponent(SlashMenuComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('open', true);
    fixture.componentRef.setInput('query', '');
  });

  describe('filter ranking', () => {
    it('ranks startsWith matches above substring matches', () => {
      service.commands.set([
        cmd('compact'),
        cmd('helper', 'Skill', 'a compact helper'),
        cmd('cost'),
        cmd('co-author'),
      ]);
      fixture.componentRef.setInput('query', 'co');
      fixture.detectChanges();

      const names = component.filtered().map((c) => c.name);
      expect(names.slice(0, 3)).toEqual(['compact', 'cost', 'co-author']);
      expect(names).toContain('helper');
      expect(names.indexOf('helper')).toBeGreaterThan(names.indexOf('compact'));
    });

    it('is case-insensitive on name and description', () => {
      service.commands.set([cmd('Help', 'Builtin', 'Show Help menu'), cmd('clear')]);
      fixture.componentRef.setInput('query', 'HELP');
      fixture.detectChanges();

      expect(component.filtered().map((c) => c.name)).toContain('Help');
    });

    it('returns full list when query is empty', () => {
      service.commands.set([cmd('one'), cmd('two')]);
      fixture.componentRef.setInput('query', '');
      fixture.detectChanges();
      expect(component.filtered().length).toBe(2);
    });
  });

  describe('keyboard navigation', () => {
    beforeEach(() => {
      service.commands.set([cmd('a'), cmd('b'), cmd('c')]);
      fixture.detectChanges();
      component.highlighted.set(0);
    });

    it('arrow down advances highlight and wraps at the end', () => {
      component.handleArrowDown(new KeyboardEvent('keydown'));
      expect(component.highlighted()).toBe(1);
      component.handleArrowDown(new KeyboardEvent('keydown'));
      expect(component.highlighted()).toBe(2);
      component.handleArrowDown(new KeyboardEvent('keydown'));
      expect(component.highlighted()).toBe(0);
    });

    it('arrow up moves highlight back and wraps at the start', () => {
      component.handleArrowUp(new KeyboardEvent('keydown'));
      expect(component.highlighted()).toBe(2);
      component.handleArrowUp(new KeyboardEvent('keydown'));
      expect(component.highlighted()).toBe(1);
    });

    it('Home jumps to first; End jumps to last', () => {
      component.highlighted.set(1);
      component.handleEnd(new KeyboardEvent('keydown'));
      expect(component.highlighted()).toBe(2);
      component.handleHome(new KeyboardEvent('keydown'));
      expect(component.highlighted()).toBe(0);
    });

    it('Enter emits selected for the highlighted command', () => {
      component.highlighted.set(1);
      const spy = vi.fn();
      component.selected.subscribe(spy);
      component.handleEnter(new KeyboardEvent('keydown'));
      expect(spy).toHaveBeenCalledWith({
        name: 'b',
        description: null,
        argument_hint: null,
        kind: 'Command',
        plugin: null,
      });
    });

    it('Escape emits closed', () => {
      const spy = vi.fn();
      component.closed.subscribe(spy);
      component.handleEscape(new KeyboardEvent('keydown'));
      expect(spy).toHaveBeenCalled();
    });

    it('keyboard handlers are no-ops when open is false', () => {
      fixture.componentRef.setInput('open', false);
      fixture.detectChanges();
      component.handleArrowDown(new KeyboardEvent('keydown'));
      expect(component.highlighted()).toBe(0);
    });

    it('Enter on empty list does not emit', () => {
      service.commands.set([]);
      fixture.detectChanges();
      const spy = vi.fn();
      component.selected.subscribe(spy);
      component.handleEnter(new KeyboardEvent('keydown'));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('ARIA', () => {
    it('role="listbox" and aria-activedescendant point at highlighted option', () => {
      service.commands.set([cmd('a'), cmd('b')]);
      fixture.detectChanges();
      component.highlighted.set(1);
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const listbox = el.querySelector('[data-testid="slash-menu"]');
      expect(listbox?.getAttribute('role')).toBe('listbox');
      expect(listbox?.getAttribute('aria-activedescendant')).toBe('slash-menu-option-1');

      const option = el.querySelector('[data-testid="slash-menu-item"][aria-selected="false"]');
      expect(option?.getAttribute('role')).toBe('option');
    });

    it('loading state uses role="status" with aria-live="polite"', () => {
      service.discovering.set(true);
      service.commands.set([]);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const status = el.querySelector('[data-testid="slash-menu-loading"]');
      expect(status?.getAttribute('role')).toBe('status');
      expect(status?.getAttribute('aria-live')).toBe('polite');
    });
  });

  describe('badge rendering', () => {
    it('renders Plugin badge with plugin name', () => {
      expect(component.badgeText(cmd('ticket', 'Plugin', null, 'redmine'))).toBe('plugin:redmine');
      expect(component.badgeText(cmd('skill', 'Skill'))).toBe('skill');
      expect(component.badgeText(cmd('help', 'Builtin'))).toBe('built-in');
      expect(component.badgeText(cmd('a', 'Agent'))).toBe('agent');
      expect(component.badgeText(cmd('c', 'Command'))).toBe('cmd');
    });

    it('renders fallback footer when source is Fallback', () => {
      service.commands.set([cmd('help', 'Builtin')]);
      service.source.set('Fallback');
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="slash-menu-fallback"]')).not.toBeNull();
    });
  });

  describe('click interaction', () => {
    it('clicking an item emits selected with that command', () => {
      service.commands.set([cmd('alpha'), cmd('beta')]);
      fixture.detectChanges();
      const spy = vi.fn();
      component.selected.subscribe(spy);
      component.select(cmd('beta'));
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ name: 'beta' }));
    });
  });
});
