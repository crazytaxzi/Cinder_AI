import type { Scene } from '@cinder/shared';
import { ToolRegistry } from './registry.js';

function usesAutomaticTwitchDelivery(scene: Scene): boolean {
  return scene.current.platform === 'twitch_chat' || scene.current.platform === 'twitch_event';
}

/**
 * Keeps platform delivery tools available for cross-platform actions without
 * exposing a second delivery path inside the room that triggered the turn.
 */
export class PlatformAwareToolRegistry extends ToolRegistry {
  override definitionsForScene(scene: Scene): ReturnType<ToolRegistry['definitionsForScene']> {
    const definitions = super.definitionsForScene(scene);
    if (!usesAutomaticTwitchDelivery(scene)) return definitions;

    return definitions.filter((definition) => definition.name !== 'twitch_send_message');
  }
}
