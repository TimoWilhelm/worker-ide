/**
 * Global ref for the preview iframe element.
 * Used by the WebSocket handler to relay CDP commands to chobitsu
 * without prop drilling through the component tree.
 */
export const previewIframeReference: { current: HTMLIFrameElement | undefined } = { current: undefined };
