import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { UiStateService } from './ui-state.service';

describe('UiStateService', () => {
  let service: UiStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(UiStateService);
  });

  describe('initial state', () => {
    it('sidebarOpen defaults to false', () => {
      expect(service.sidebarOpen()).toBe(false);
    });

    it('memoryOpen defaults to false', () => {
      expect(service.memoryOpen()).toBe(false);
    });

    it('paletteOpen defaults to false', () => {
      expect(service.paletteOpen()).toBe(false);
    });

    it('projectSwitcherOpen defaults to false', () => {
      expect(service.projectSwitcherOpen()).toBe(false);
    });
  });

  describe('toggleSidebar', () => {
    it('flips sidebarOpen from false to true', () => {
      service.toggleSidebar();
      expect(service.sidebarOpen()).toBe(true);
    });

    it('flips sidebarOpen from true back to false', () => {
      service.toggleSidebar();
      service.toggleSidebar();
      expect(service.sidebarOpen()).toBe(false);
    });

    it('does not affect memoryOpen', () => {
      service.toggleSidebar();
      expect(service.memoryOpen()).toBe(false);
    });

    it('opens sidebar while memory is open → closes memory', () => {
      service.toggleMemory();
      service.toggleSidebar();
      expect(service.memoryOpen()).toBe(false);
      expect(service.sidebarOpen()).toBe(true);
    });
  });

  describe('toggleMemory', () => {
    it('flips memoryOpen from false to true', () => {
      service.toggleMemory();
      expect(service.memoryOpen()).toBe(true);
    });

    it('flips memoryOpen from true back to false', () => {
      service.toggleMemory();
      service.toggleMemory();
      expect(service.memoryOpen()).toBe(false);
    });

    it('does not affect sidebarOpen', () => {
      service.toggleMemory();
      expect(service.sidebarOpen()).toBe(false);
    });

    it('opens memory while sidebar is open → closes sidebar', () => {
      service.toggleSidebar();
      service.toggleMemory();
      expect(service.sidebarOpen()).toBe(false);
      expect(service.memoryOpen()).toBe(true);
    });
  });

  describe('closeSidebar', () => {
    it('sets sidebarOpen to false when open', () => {
      service.toggleSidebar();
      service.closeSidebar();
      expect(service.sidebarOpen()).toBe(false);
    });

    it('leaves sidebarOpen false when already closed', () => {
      service.closeSidebar();
      expect(service.sidebarOpen()).toBe(false);
    });
  });

  describe('closeMemory', () => {
    it('sets memoryOpen to false when open', () => {
      service.toggleMemory();
      service.closeMemory();
      expect(service.memoryOpen()).toBe(false);
    });

    it('leaves memoryOpen false when already closed', () => {
      service.closeMemory();
      expect(service.memoryOpen()).toBe(false);
    });
  });

  describe('togglePalette', () => {
    it('flips paletteOpen from false to true', () => {
      service.togglePalette();
      expect(service.paletteOpen()).toBe(true);
    });

    it('flips paletteOpen from true back to false', () => {
      service.togglePalette();
      service.togglePalette();
      expect(service.paletteOpen()).toBe(false);
    });
  });

  describe('toggleProjectSwitcher', () => {
    it('flips projectSwitcherOpen from false to true', () => {
      service.toggleProjectSwitcher();
      expect(service.projectSwitcherOpen()).toBe(true);
    });

    it('flips projectSwitcherOpen from true back to false', () => {
      service.toggleProjectSwitcher();
      service.toggleProjectSwitcher();
      expect(service.projectSwitcherOpen()).toBe(false);
    });
  });

  describe('closePalette', () => {
    it('sets paletteOpen to false when open', () => {
      service.togglePalette();
      service.closePalette();
      expect(service.paletteOpen()).toBe(false);
    });

    it('leaves paletteOpen false when already closed', () => {
      service.closePalette();
      expect(service.paletteOpen()).toBe(false);
    });
  });

  describe('closeProjectSwitcher', () => {
    it('sets projectSwitcherOpen to false when open', () => {
      service.toggleProjectSwitcher();
      service.closeProjectSwitcher();
      expect(service.projectSwitcherOpen()).toBe(false);
    });

    it('leaves projectSwitcherOpen false when already closed', () => {
      service.closeProjectSwitcher();
      expect(service.projectSwitcherOpen()).toBe(false);
    });
  });

  describe('singleton scoping', () => {
    it('returns the same instance across inject() calls', () => {
      const second = TestBed.inject(UiStateService);
      expect(second).toBe(service);
    });
  });
});
