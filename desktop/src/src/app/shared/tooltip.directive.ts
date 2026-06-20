import {
  ConnectedPosition,
  Overlay,
  OverlayPositionBuilder,
  OverlayRef,
  ScrollStrategyOptions,
} from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
} from '@angular/core';

/** Where the tooltip floats relative to the host. */
export type TooltipPlacement = 'top' | 'right' | 'bottom' | 'left';

/** Pixels offset between the host edge and the tooltip body. */
const OFFSET_PX = 8;

/** Internal CDK-overlay panel; `.app-tooltip` class + `data-state` fade attr. */
@Component({
  selector: 'app-tooltip-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    {{ label() }}
    @if (kbd()) {
      <span class="kbd ml-1">{{ kbd() }}</span>
    }
  `,
  host: {
    class: 'app-tooltip',
    role: 'tooltip',
    '[attr.data-placement]': 'placement()',
    '[attr.data-state]': 'visible() ? "open" : "closed"',
  },
})
export class TooltipPanelComponent {
  readonly label = input<string>('');
  readonly kbd = input<string>('');
  readonly placement = input<TooltipPlacement>('bottom');
  readonly visible = input<boolean>(false);
}

/** Position pairs (origin → overlay) for each placement, with one fallback. */
const POSITIONS: Record<TooltipPlacement, ConnectedPosition[]> = {
  top: [
    {
      originX: 'center',
      originY: 'top',
      overlayX: 'center',
      overlayY: 'bottom',
      offsetY: -OFFSET_PX,
    },
    // Fallback: bottom
    {
      originX: 'center',
      originY: 'bottom',
      overlayX: 'center',
      overlayY: 'top',
      offsetY: OFFSET_PX,
    },
  ],
  bottom: [
    {
      originX: 'center',
      originY: 'bottom',
      overlayX: 'center',
      overlayY: 'top',
      offsetY: OFFSET_PX,
    },
    // Fallback: top
    {
      originX: 'center',
      originY: 'top',
      overlayX: 'center',
      overlayY: 'bottom',
      offsetY: -OFFSET_PX,
    },
  ],
  left: [
    {
      originX: 'start',
      originY: 'center',
      overlayX: 'end',
      overlayY: 'center',
      offsetX: -OFFSET_PX,
    },
    // Fallback: right
    {
      originX: 'end',
      originY: 'center',
      overlayX: 'start',
      overlayY: 'center',
      offsetX: OFFSET_PX,
    },
  ],
  right: [
    {
      originX: 'end',
      originY: 'center',
      overlayX: 'start',
      overlayY: 'center',
      offsetX: OFFSET_PX,
    },
    // Fallback: left
    {
      originX: 'start',
      originY: 'center',
      overlayX: 'end',
      overlayY: 'center',
      offsetX: -OFFSET_PX,
    },
  ],
};

/** Custom tooltip directive — SSOT for hover/focus tooltips; renders via CDK Overlay, strips native `title`. */
@Directive({
  selector: '[appTooltip]',
  standalone: true,
})
export class TooltipDirective implements OnDestroy {
  /** Tooltip label. Falsy values disable the tooltip. */
  readonly label = input<string>('', { alias: 'appTooltip' });
  /** Optional keyboard shortcut shown after the label as a kbd chip. */
  readonly tooltipKbd = input<string>('');
  /** Where to float relative to the host. */
  readonly placement = input<TooltipPlacement>('bottom');

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly overlay = inject(Overlay);
  private readonly positionBuilder = inject(OverlayPositionBuilder);
  private readonly scrollStrategies = inject(ScrollStrategyOptions);

  private overlayRef: OverlayRef | null = null;
  private panelRef: { setInput: (name: string, value: unknown) => void } | null = null;

  /** Re-derive the position list whenever the requested placement changes. */
  private readonly positions = computed(() => POSITIONS[this.placement()]);

  /** Wires the effects that strip the native `title` and sync panel inputs. */
  constructor() {
    // Strip native `title`; effect re-runs on label change.
    effect(() => {
      this.label();
      this.host.nativeElement.removeAttribute('title');
    });

    // Sync live panel inputs (label/kbd/placement) while visible.
    effect(() => {
      const ref = this.panelRef;
      if (!ref) return;
      ref.setInput('label', this.label());
      ref.setInput('kbd', this.tooltipKbd());
      ref.setInput('placement', this.placement());
    });

    // Reposition the overlay when placement changes mid-flight.
    effect(() => {
      const positions = this.positions();
      if (this.overlayRef) {
        const strategy = this.overlayRef.getConfig().positionStrategy as ReturnType<
          OverlayPositionBuilder['flexibleConnectedTo']
        >;
        strategy.withPositions(positions);
        this.overlayRef.updatePosition();
      }
    });
  }

  /** Show the tooltip when the host receives a hover. */
  @HostListener('mouseenter') onEnter(): void {
    this.show();
  }

  /** Show the tooltip when the host receives keyboard focus. */
  @HostListener('focusin') onFocus(): void {
    this.show();
  }

  /** Hide the tooltip when the cursor leaves the host. */
  @HostListener('mouseleave') onLeave(): void {
    this.hide();
  }

  /** Hide the tooltip when the host loses focus. */
  @HostListener('focusout') onBlur(): void {
    this.hide();
  }

  /** Click dismisses the tooltip; prevents a stale chip when host layout changes. */
  @HostListener('click') onClick(): void {
    this.hide();
  }

  /** Tear down the overlay and detach any live panel on destroy. */
  ngOnDestroy(): void {
    this.hide();
    this.overlayRef?.dispose();
    this.overlayRef = null;
  }

  private show(): void {
    const text = this.label();
    if (!text || this.panelRef) return;

    if (!this.overlayRef) {
      const positionStrategy = this.positionBuilder
        .flexibleConnectedTo(this.host)
        .withPositions(this.positions())
        .withPush(false)
        .withFlexibleDimensions(false)
        .withViewportMargin(4);

      this.overlayRef = this.overlay.create({
        positionStrategy,
        scrollStrategy: this.scrollStrategies.close(),
        // Non-interactive panel; CSS pointer-events:none keeps host hover stable.
        hasBackdrop: false,
        disposeOnNavigation: true,
      });
    }

    const portal = new ComponentPortal(TooltipPanelComponent);
    const componentRef = this.overlayRef.attach(portal);
    componentRef.setInput('label', text);
    componentRef.setInput('kbd', this.tooltipKbd());
    componentRef.setInput('placement', this.placement());
    componentRef.setInput('visible', false);

    this.panelRef = componentRef;

    // Force reflow, then flip data-state to trigger the opacity transition.
    const overlayEl = this.overlayRef.overlayElement;
    void overlayEl.offsetWidth;
    componentRef.setInput('visible', true);
    componentRef.changeDetectorRef.detectChanges();
  }

  private hide(): void {
    if (!this.overlayRef || !this.panelRef) return;
    this.overlayRef.detach();
    this.panelRef = null;
  }
}
