import { cameraActions } from "../scene/CameraRig";

export function CameraControls() {
  return (
    <div className="glass cam" role="toolbar" aria-label="Camera">
      <button onClick={() => cameraActions.zoomIn()} aria-label="Zoom in">+</button>
      <button onClick={() => cameraActions.zoomOut()} aria-label="Zoom out">−</button>
      <button onClick={() => cameraActions.rotate()} aria-label="Rotate 30 degrees">↻</button>
      <button onClick={() => cameraActions.home()} aria-label="Reset view">⌂</button>
    </div>
  );
}
