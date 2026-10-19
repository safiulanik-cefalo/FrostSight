/** Called by the HUD's camera buttons; bound to the live controls once the canvas mounts. Kept apart from
 * CameraRig so the HUD does not pull three.js into the 2D map's bundle. */
export const cameraActions = {
  zoomIn: () => {},
  zoomOut: () => {},
  rotate: () => {},
  home: () => {},
};
