import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IdeBridgeComponent } from './ide-bridge.component';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

function setupMockTauri(mockTauri: MockTauriService): void {
  mockTauri.invokeHandler = async (cmd: string) => {
    switch (cmd) {
      case 'list_available_ides':
        return [];
      case 'get_selected_ide':
        return null;
      default:
        return undefined;
    }
  };
}

describe('IdeBridgeComponent', () => {
  let component: IdeBridgeComponent;
  let fixture: ComponentFixture<IdeBridgeComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    setupMockTauri(mockTauri);

    await TestBed.configureTestingModule({
      imports: [IdeBridgeComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(IdeBridgeComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    component.ngOnDestroy();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('loads available IDEs on init', async () => {
    const mockIdes = [
      { ide_name: 'VS Code', port: 3000, ws_url: 'ws://localhost:3000' },
      { ide_name: 'Cursor', port: 3001, ws_url: 'ws://localhost:3001' },
    ];
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_available_ides':
          return mockIdes;
        case 'get_selected_ide':
          return null;
        default:
          return undefined;
      }
    };
    await component.ngOnInit();
    await new Promise((r) => setTimeout(r, 0));
    expect(component.availableIdes).toEqual(mockIdes);
  });

  it('connectIde invokes select_ide and sets selectedIde', async () => {
    await component.ngOnInit();
    const ide = { ide_name: 'VS Code', port: 3000, ws_url: 'ws://localhost:3000' };
    const invokeSpy = vi.spyOn(mockTauri, 'invoke');
    await component.connectIde(ide);
    expect(invokeSpy).toHaveBeenCalledWith('select_ide', { ideName: 'VS Code', port: 3000 });
    expect(component.selectedIde).toEqual({ ide_name: 'VS Code', port: 3000 });
    expect(component.ideConnecting).toBe(false);
  });

  it('connectIde sets error when port is null', async () => {
    await component.ngOnInit();
    const ide = { ide_name: 'VS Code', port: null, ws_url: null };
    await component.connectIde(ide);
    expect(component.ideError).toBe('VS Code has no port — cannot connect');
    expect(component.selectedIde).toBeNull();
  });

  it('connectIde sets error on invoke failure', async () => {
    await component.ngOnInit();
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'select_ide') throw new Error('connection refused');
      return undefined;
    };
    const ide = { ide_name: 'VS Code', port: 3000, ws_url: 'ws://localhost:3000' };
    await component.connectIde(ide);
    expect(component.ideError).toBe('Failed to connect to VS Code: Error: connection refused');
    expect(component.ideConnecting).toBe(false);
  });

  it('loads selected IDE from backend on init', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_available_ides':
          return [{ ide_name: 'Cursor', port: 4000, ws_url: 'ws://localhost:4000' }];
        case 'get_selected_ide':
          return { ide_name: 'Cursor', port: 4000 };
        default:
          return undefined;
      }
    };
    await component.ngOnInit();
    expect(component.selectedIde).toEqual({ ide_name: 'Cursor', port: 4000 });
  });

  it('IDE bridge event listener sets lastEvent', async () => {
    await component.ngOnInit();
    mockTauri.dispatchEvent('ide_bridge_event', { kind: 'openFile', detail: '/src/main.rs' });
    expect(component.lastEvent).toBe('openFile: /src/main.rs');
  });

  it('ngOnDestroy clears IDE polling and event listener', async () => {
    await component.ngOnInit();
    expect(mockTauri.listenHandlers['ide_bridge_event']).toBeDefined();

    component.ngOnDestroy();

    expect(mockTauri.listenHandlers['ide_bridge_event']).toBeUndefined();
  });

  it('shows no-data message when no IDEs available', async () => {
    await component.ngOnInit();
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const noData = fixture.nativeElement.querySelector('.no-data');
    expect(noData).not.toBeNull();
    expect(noData.textContent).toContain('No IDE detected');
  });

  it('renders IDE rows when IDEs are available', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_available_ides':
          return [
            { ide_name: 'VS Code', port: 3000, ws_url: 'ws://localhost:3000' },
            { ide_name: 'Cursor', port: 3001, ws_url: 'ws://localhost:3001' },
          ];
        case 'get_selected_ide':
          return null;
        default:
          return undefined;
      }
    };
    await component.ngOnInit();
    await new Promise((r) => setTimeout(r, 0));
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('.ide-row');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.ide-row-name').textContent.trim()).toBe('VS Code');
    expect(rows[1].querySelector('.ide-row-name').textContent.trim()).toBe('Cursor');
  });

  it('shows connected button for selected IDE', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      switch (cmd) {
        case 'list_available_ides':
          return [{ ide_name: 'VS Code', port: 3000, ws_url: 'ws://localhost:3000' }];
        case 'get_selected_ide':
          return { ide_name: 'VS Code', port: 3000 };
        default:
          return undefined;
      }
    };
    await component.ngOnInit();
    await new Promise((r) => setTimeout(r, 0));
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('.connect-btn');
    expect(btn.textContent.trim()).toBe('Connected');
    expect(btn.classList.contains('active')).toBe(true);
  });

  it('displays ideError when present', async () => {
    await component.ngOnInit();
    component.ideError = 'Some error';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const errorBanner = fixture.nativeElement.querySelector('.error-banner');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner.textContent).toContain('Some error');
  });
});
