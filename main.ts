import { Plugin, App, PluginSettingTab, Setting, Notice, TFile, FileSystemAdapter, Menu } from 'obsidian';

import { ImageInteractionController } from './src/image-interaction-controller';
import { buildArguments } from './src/external-editor';

interface ImageZoomSettings {
    externalEditorPath: string;
    externalEditorArguments: string;
    useSystemDefault: boolean;
    disableNativeImageInteractions: boolean;
    debugImageInteractions: boolean;
}

interface ImageState {
    isDragging: boolean;
    initialX: number;
    initialY: number;
    offsetX: number;
    offsetY: number;
    scale: number;
    resetButton: HTMLButtonElement | null;
    controlsContainer: HTMLDivElement | null;
    isSvg: boolean;
    originalViewBox: { x: number; y: number; width: number; height: number; } | null;
    svgViewBox: { x: number; y: number; width: number; height: number; } | null;
    resizeObserver: ResizeObserver | null;
    // Original styles and attributes for restoration
    originalStyles: {
        transform: string | null;
        transformOrigin: string | null;
        transition: string | null;
        cursor: string | null;
        width: string | null;
        height: string | null;
    };
    parentElement: HTMLElement | null;
    originalAttributes: {
        viewBox: string | null;
        width: string | null;
        height: string | null;
        preserveAspectRatio: string | null;
    };
}

const DEFAULT_SETTINGS: ImageZoomSettings = {
    externalEditorPath: '',
    externalEditorArguments: '"{file}"',
    useSystemDefault: true,
    disableNativeImageInteractions: false,
    debugImageInteractions: false,
}

export default class ImageZoomDragPlugin extends Plugin {
    settings: ImageZoomSettings;
    // Multi-image state management
    private zoomedImages = new Map<HTMLImageElement | SVGSVGElement, ImageState>(); // Stores state for each zoomed image
    private currentDragTarget: HTMLImageElement | SVGSVGElement | null = null; // Track which image is currently being dragged
    private globalResizeObservers = new Set<ResizeObserver>(); // Track all resize observers
    private resizeObserver: ResizeObserver | null = null;

    // Reference counting for modified parent elements (position: relative)
    private parentRegistry = new Map<HTMLElement, { count: number, originalPosition: string }>();

    private interactionController: ImageInteractionController;



    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'toggle-exclusive-image-handling',
            name: 'Toggle exclusive image handling',
            icon: 'image',
            callback: () => {
                void this.setExclusiveImageHandling(!this.settings.disableNativeImageInteractions, 'command');
            }
        });

        console.log("[Image Pan and Zoom] Loaded", {
            pluginId: this.manifest.id,
            version: this.manifest.version,
            buildRevision: typeof BUILD_REVISION !== 'undefined' ? BUILD_REVISION : 'unknown',
            exclusiveImageHandling: this.settings.disableNativeImageInteractions,
            toggleCommandRegistered: true
        });

        this.addSettingTab(new ImageZoomSettingTab(this.app, this));


        this.interactionController = new ImageInteractionController(this, this.app);

        // Register for main document
        this.interactionController.registerDocument(document);


        // Register for popout windows if supported
        if (this.app.workspace.on) {
            this.registerEvent(
                this.app.workspace.on('window-open', (win, window) => {
                    this.interactionController.registerDocument(window.document);
                })
            );
            this.registerEvent(
                this.app.workspace.on('window-close', (win, window) => {
                    this.interactionController.unregisterDocument(window.document);
                    this.cleanupDetachedImages();
                })
            );
        }


        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                this.zoomedImages.forEach((imageState, target) => {
                    if (target.tagName.toLowerCase() === 'img' && file instanceof TFile) {
                        const imgTarget = target as HTMLImageElement;
                        const imageSrc = imgTarget.getAttribute('src');
                        if (!imageSrc) return;

                        const sanitizedSrc = decodeURIComponent(imageSrc.split('?')[0]);

                        if (file.path === sanitizedSrc) {
                            // Refresh the image
                            const timestamp = new Date().getTime();
                            imgTarget.src = file.path + '?t=' + timestamp;
                        }
                    }
                });
            })
        );

        // ADD THIS: Register file-menu event for images
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                // Only show for image files
                if (file instanceof TFile && this.isImageFile(file)) {
                    const isTakeover = this.settings.disableNativeImageInteractions;
                    menu.addItem((item) => {
                        item
                            .setTitle(isTakeover ? 'Disable exclusive image handling' : 'Enable exclusive image handling')
                            .setIcon(isTakeover ? 'image-minus' : 'image-plus')
                            .onClick(() => {
                                void this.setExclusiveImageHandling(!isTakeover, 'file-menu');
                            });
                    });

                    menu.addItem((item) => {
                        item
                            .setTitle('Edit in external app')
                            .setIcon('pencil')
                            .onClick(async () => {
                                await this.openImageInExternalApp(file as TFile);
                            });
                    });
                }
            })
        );
    }

    onunload() {
        this.endCurrentDrag("plugin-unload");

        // Clean up all resize observers
        this.globalResizeObservers.forEach(observer => observer.disconnect());
        this.globalResizeObservers.clear();

        if (this.interactionController) {
            this.interactionController.dispose();
        }


        // Reset all zoomed images
        this.zoomedImages.forEach((imageState, target) => {
            this.resetImage(target);
        });
        this.zoomedImages.clear();
    }


    cleanupDetachedImages() {
        this.zoomedImages.forEach((imageState, target) => {
            if (!document.contains(target)) {
                let isInAnyDoc = false;
                // Check if it's in any popout window
                if (this.interactionController) {
                    const docs = this.interactionController.getRegisteredDocuments();
                    for (const doc of docs) {
                        if (doc.contains(target)) {
                            isInAnyDoc = true;
                            break;
                        }
                    }
                }

                if (!isInAnyDoc) {
                    this.resetImage(target);
                }
            }
        });
    }


    async showImageManagementMenu(event: MouseEvent, target: HTMLImageElement | SVGSVGElement) {
        const menu = new Menu();

        // 1. Disable exclusive image handling
        menu.addItem((item) => {
            item
                .setTitle('Disable exclusive image handling')
                .setIcon('image-minus')
                .onClick(() => {
                    void this.setExclusiveImageHandling(false, 'image-menu');
                });
        });

        // 2. Activate / Reset
        const isActive = this.isImageActive(target);
        if (isActive) {
            menu.addItem((item) => {
                item
                    .setTitle('Reset zoom and pan')
                    .setIcon('reset')
                    .onClick(() => {
                        this.resetImage(target);
                    });
            });
        } else {
            menu.addItem((item) => {
                item
                    .setTitle('Activate pan and zoom')
                    .setIcon('zoom-in')
                    .onClick(() => {
                        this.activateImage(target);
                    });
            });
        }

        // 3. Edit in external app (only for vault image files)
        if (target.tagName.toLowerCase() === 'img') {
            const file = await this.findFileFromImageElement(target as HTMLImageElement);
            if (file) {
                menu.addItem((item) => {
                    item
                        .setTitle('Edit in external app')
                        .setIcon('pencil')
                        .onClick(async () => {
                            await this.openImageInExternalApp(file);
                        });
                });
            }
        }

        menu.showAtMouseEvent(event);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }


    private isTogglingExclusiveHandling = false;

    async setExclusiveImageHandling(
        enabled: boolean,
        source: 'settings' | 'command' | 'image-menu' | 'file-menu'
    ): Promise<void> {
        if (this.isTogglingExclusiveHandling) {
            return;
        }
        this.isTogglingExclusiveHandling = true;

        const previous = this.settings.disableNativeImageInteractions;

        try {
            this.endCurrentDrag("exclusive-handling-changed");

            this.settings.disableNativeImageInteractions = enabled;
            await this.saveSettings();

            console.log("[Image Pan and Zoom] Exclusive image handling changed", {
                previous,
                enabled,
                source
            });

            if (source !== 'settings') {
                new Notice(enabled ? "Exclusive image handling enabled" : "Exclusive image handling disabled");
            }

            // Refresh settings UI if open
            const activeTab = (this.app as any).setting?.activeTab;
            if (activeTab && activeTab.id === this.manifest.id) {
                activeTab.display();
            }
        } catch (error) {
            console.error(
                "[Image Pan and Zoom] Failed to persist exclusive image handling",
                error
            );
            this.settings.disableNativeImageInteractions = previous;

            // Refresh settings UI if open to reflect fallback
            const activeTab = (this.app as any).setting?.activeTab;
            if (activeTab && activeTab.id === this.manifest.id) {
                activeTab.display();
            }
        } finally {
            this.isTogglingExclusiveHandling = false;
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async openImageInExternalApp(file: TFile) {
        if (!file || !(file instanceof TFile)) {
            new Notice("Could not locate image file in vault");
            return;
        }

        // Require desktop filesystem support
        if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
            new Notice("External editors are only supported on desktop filesystems.");
            return;
        }

        const path = require("path");
        const fs = require("fs");

        // Get the clean file path (remove any query parameters)
        let filePath = file.path;
        
        // Strip query parameters if present (e.g., ?timestamp)
        if (filePath.includes('?')) {
            filePath = filePath.split('?')[0];
        }

        // Get full filesystem path
        const basePath = this.app.vault.adapter.getBasePath();
        filePath = path.join(basePath, filePath);
        filePath = path.normalize(filePath);

        // Confirm the image still exists
        if (!fs.existsSync(filePath)) {
            new Notice("Image file no longer exists on disk.");
            return;
        }

        if (this.settings.useSystemDefault) {
            require("electron").shell.openPath(filePath)
                .then((errorMessage: string) => {
                    // openPath returns an empty string on success, or an error message on failure
                    if (errorMessage) {
                        new Notice("Failed to open image: " + errorMessage);
                        console.error("Error opening image:", errorMessage);
                        console.error("Path attempted:", filePath);
                    } else {
                        new Notice("Image opened in external app");
                    }
                })
                .catch((i: any) => {
                    new Notice("Failed to open image: " + i.message);
                    console.error("Error opening image:", i);
                    console.error("Path attempted:", filePath);
                });
        } else {
            const editorPath = this.settings.externalEditorPath;
            if (!editorPath) {
                new Notice("Please configure external editor path in settings");
                return;
            }
            const { spawn } = require("child_process");
            const path = require("path");

            // Validate executable path
            let executablePath = editorPath.trim();
            // Remove single surrounding quotes if present
            if (executablePath.startsWith('"') && executablePath.endsWith('"')) {
                executablePath = executablePath.substring(1, executablePath.length - 1);
            }

            let args: string[];
            try {
                args = buildArguments(this.settings.externalEditorArguments || '"{file}"', filePath);
            } catch (e: any) {
                new Notice("Invalid argument template: " + e.message);
                console.error("[Image Pan and Zoom] Argument parsing error:", e.message);
                return;
            }

            if (this.settings.debugImageInteractions) {
                console.log("[Image Pan and Zoom] External editor launch details", {
                    executable: executablePath,
                    arguments: args
                });
            }

            console.log("[Image Pan and Zoom] External editor launch requested", {
                editorName: path.basename(executablePath),
                argumentCount: args.length,
                usesFilePlaceholder: true,
                shell: false
            });

            try {
                const child = spawn(executablePath, args, {
                    shell: false,
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true
                });

                child.once('error', (error: NodeJS.ErrnoException) => {
                    console.error("[Image Pan and Zoom] External editor launch failed", {
                        code: error.code,
                        message: error.message
                    });
                    new Notice("Could not launch the external image editor. Check its executable path and arguments.");
                });

                child.once('spawn', () => {
                    console.log("[Image Pan and Zoom] External editor process started", {
                        pid: child.pid
                    });
                    new Notice("External image editor launched");
                    child.unref();
                });
            } catch (h: any) {
                new Notice("Failed to launch external editor: " + h.message);
                console.error("[Image Pan and Zoom] External editor error:", h);
            }
        }
    }

    async findFileFromImageElement(imageElement: HTMLImageElement): Promise<TFile | null> {
        let src = imageElement.getAttribute("src");
        if (!src) {
            new Notice("Could not get image source");
            return null;
        }

        // Reject remote URLs
        if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('app://')) {
            // It could be a local app:// URL on desktop.
            // We'll proceed to check the actual decoded path in a moment,
            // but let's strictly reject http/https right away.
            if (src.startsWith('http://') || src.startsWith('https://')) {
                new Notice("Remote images cannot be opened in a local editor.");
                return null;
            }
        }

        // Try getting the source directly from the embed wrapper metadata if possible
        const embedWrapper = imageElement.closest('.internal-embed.image-embed');
        let linkText = '';
        if (embedWrapper) {
            linkText = embedWrapper.getAttribute('src') || '';
        }

        // Decode the raw DOM src
        src = decodeURIComponent(src.split("?")[0]);

        // Find the active file to resolve relative links against
        const activeFile = this.app.workspace.getActiveFile();
        let sourcePath = activeFile ? activeFile.path : '';

        let targetFile: TFile | null = null;

        // Use Obsidian's metadata cache to resolve the link if we got it from the embed
        if (linkText) {
            const resolved = this.app.metadataCache.getFirstLinkpathDest(linkText, sourcePath);
            if (resolved instanceof TFile) {
                targetFile = resolved;
            }
        }

        if (!targetFile) {
            // Attempt to resolve by exact vault path using the DOM src
            const abstractFile = this.app.vault.getAbstractFileByPath(src);
            if (abstractFile instanceof TFile) {
                targetFile = abstractFile;
            }
        }

        if (!targetFile) {
            // Last resort: extract filename and use link resolution
            const filename = src.split('/').pop() || src;
            const resolved = this.app.metadataCache.getFirstLinkpathDest(filename, sourcePath);

            if (resolved instanceof TFile) {
                // If it successfully mapped to a single file through cache
                targetFile = resolved;
            } else {
                // Check if multiple files have this name
                const allFiles = this.app.vault.getFiles();
                const matches = allFiles.filter(f => f.name === filename);
                if (matches.length > 1) {
                    new Notice("Multiple images with this name exist. Open the specific file directly.");
                    return null;
                } else if (matches.length === 1) {
                    targetFile = matches[0];
                }
            }
        }

        if (targetFile && this.isImageFile(targetFile)) {
            return targetFile;
        }

        new Notice("Could not resolve image to a valid vault file.");
        return null;
    }



    handleEscape(e: KeyboardEvent) {
        if (this.zoomedImages.size > 0) {
            this.zoomedImages.forEach((imageState, target) => {
                this.resetImage(target);
            });
        }
    }

    isImageActive(target: HTMLImageElement | SVGSVGElement): boolean {
        return this.zoomedImages.has(target);
    }

    activateImage(target: HTMLImageElement | SVGSVGElement) {
        // Create new zoom state for this image
        const imageState: ImageState = {
            isDragging: false,
            initialX: 0,
            initialY: 0,
            offsetX: 0,
            offsetY: 0,
            scale: 1,
            resetButton: null,
            controlsContainer: null,
            isSvg: target.tagName.toLowerCase() === 'svg',
            originalViewBox: null,
            svgViewBox: null,
            resizeObserver: null,
            originalStyles: {
                transform: target.style.transform || null,
                transformOrigin: target.style.transformOrigin || null,
                transition: target.style.transition || null,
                cursor: target.style.cursor || null,
                width: target.style.width || null,
                height: target.style.height || null
            },
            parentElement: target.parentElement,

            originalAttributes: {
                viewBox: target.getAttribute("viewBox"),
                width: target.getAttribute("width"),
                height: target.getAttribute("height"),
                preserveAspectRatio: target.getAttribute("preserveAspectRatio")
            }
        };

        // Handle SVG-specific setup
        if (imageState.isSvg) {
            const svg = target as SVGSVGElement;
            const viewBox = svg.getAttribute("viewBox");
            if (viewBox) {
                const parsedViewBox = this.parseViewBox(viewBox);
                if (parsedViewBox) {
                    imageState.originalViewBox = parsedViewBox;
                    imageState.svgViewBox = { ...parsedViewBox };
                }
            }
            const resizeObserver = this.setupDynamicResize(svg);
            if (resizeObserver) {
                imageState.resizeObserver = resizeObserver;
                this.globalResizeObservers.add(imageState.resizeObserver);
            }
        }

        // Store state and activate zoom
        this.zoomedImages.set(target, imageState);
        target.classList.add("image-zoom-drag-active");
        target.style.cursor = "grab";
        this.showResetButton(target);
    }

    handleWheelInternal(e: WheelEvent, target: HTMLImageElement | SVGSVGElement) {
        const imageState = this.zoomedImages.get(target);
        if (!imageState || !this.isMouseWithinFrame(e, target)) return;

        const zoomFactor = 1.1;
        const previousScale = imageState.scale;

        if (e.deltaY < 0) {
            imageState.scale *= zoomFactor;
        } else {
            imageState.scale /= zoomFactor;
        }

        imageState.scale = Math.max(0.1, imageState.scale);

        const rect = target.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const scaleRatio = imageState.scale / previousScale;

        imageState.offsetX = mouseX - (mouseX - imageState.offsetX) * scaleRatio;
        imageState.offsetY = mouseY - (mouseY - imageState.offsetY) * scaleRatio;

        if (imageState.isSvg && imageState.svgViewBox && imageState.originalViewBox) {
            const viewBoxWidth = imageState.originalViewBox.width / imageState.scale;
            const viewBoxHeight = imageState.originalViewBox.height / imageState.scale;

            imageState.svgViewBox.x = imageState.originalViewBox.x - imageState.offsetX * (viewBoxWidth / imageState.originalViewBox.width);
            imageState.svgViewBox.y = imageState.originalViewBox.y - imageState.offsetY * (viewBoxHeight / imageState.originalViewBox.height);
            imageState.svgViewBox.width = viewBoxWidth;
            imageState.svgViewBox.height = viewBoxHeight;
        }

        this.updateTransform(target, imageState);
        if (imageState.isSvg) this.fitSvgToContainer(target as SVGSVGElement);
    }

    startPan(e: MouseEvent, target: HTMLImageElement | SVGSVGElement) {
        const imageState = this.zoomedImages.get(target);
        if (!imageState || !this.isMouseWithinFrame(e, target)) return;

        this.currentDragTarget = target;
        imageState.isDragging = true;
        imageState.initialX = e.clientX - imageState.offsetX;
        imageState.initialY = e.clientY - imageState.offsetY;
        target.classList.add("is-dragging");
    }



    parseViewBox(viewBoxString: string): { x: number; y: number; width: number; height: number; } | null {
        const parts = viewBoxString.split(' ').map(parseFloat);
        if (parts.length !== 4) {
            return null;
        }
        return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }

    fitSvgToContainer(svg: SVGSVGElement) {
        const container = svg.closest('.workspace-leaf-content') || svg.parentElement;
        if (container) {
            const width = container.clientWidth;
            const height = container.clientHeight;
            svg.setAttribute('width', `${width}`);
            svg.setAttribute('height', `${height}`);
            svg.style.width = `${width}px`;
            svg.style.height = `${height}px`;
            svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        }
    }

    setupDynamicResize(svg: SVGSVGElement) {
        const container = svg.closest('.workspace-leaf-content') || svg.parentElement;
        if (container) {
            const resizeObserver = new ResizeObserver(() => {
                this.fitSvgToContainer(svg);
            });
            resizeObserver.observe(container);
            this.fitSvgToContainer(svg);
            return resizeObserver;
        }
        return null;
    }





    handleMouseMove(e: MouseEvent) {
        if (!this.currentDragTarget) return;

        const imageState = this.zoomedImages.get(this.currentDragTarget);
        if (!imageState || !imageState.isDragging) return;

        const rect = this.currentDragTarget.getBoundingClientRect();
        const buffer = 100;
        if (e.clientX < rect.left - buffer || e.clientX > rect.right + buffer ||
            e.clientY < rect.top - buffer || e.clientY > rect.bottom + buffer) {
            this.endCurrentDrag("out-of-bounds");
            return;
        }

        if (imageState.isSvg && imageState.svgViewBox) {
            imageState.svgViewBox.x -= e.movementX * (imageState.svgViewBox.width / this.currentDragTarget.getBoundingClientRect().width);
            imageState.svgViewBox.y -= e.movementY * (imageState.svgViewBox.height / this.currentDragTarget.getBoundingClientRect().height);
        } else {
            imageState.offsetX += e.movementX;
            imageState.offsetY += e.movementY;
        }

        this.updateTransform(this.currentDragTarget, imageState);
        if (imageState.isSvg) this.fitSvgToContainer(this.currentDragTarget as SVGSVGElement);
    }


    endCurrentDrag(reason: string): void {
        if (!this.currentDragTarget) return;

        const imageState = this.zoomedImages.get(this.currentDragTarget);
        if (imageState) {
            imageState.isDragging = false;
        }

        this.currentDragTarget.classList.remove("is-dragging");
        this.currentDragTarget = null;

        if (this.settings.debugImageInteractions) {
            console.log("[Image Pan and Zoom] Drag ended", { reason });
        }
    }

    handleMouseUp(e: MouseEvent) {
        this.endCurrentDrag("mouse-up");
    }

    updateTransform(target: HTMLImageElement | SVGSVGElement, imageState: any) {
        if (!target || !imageState) return;

        if (imageState.isSvg) {
            this.updateSvgTransform(target as SVGSVGElement, imageState);
        } else {
            target.style.transform = `translate(${imageState.offsetX}px, ${imageState.offsetY}px) scale(${imageState.scale})`;
            target.style.transformOrigin = "top left";
            target.style.transition = "transform 0.1s ease-out";
        }
    }

    updateSvgTransform(target: SVGSVGElement, imageState: any) {
        if (!target || !imageState.svgViewBox) return;
        target.setAttribute("viewBox", `${imageState.svgViewBox.x} ${imageState.svgViewBox.y} ${imageState.svgViewBox.width} ${imageState.svgViewBox.height}`);
    }

    resetImage(target: HTMLImageElement | SVGSVGElement) {
        const imageState = this.zoomedImages.get(target);
        if (!imageState) return;

        if (this.currentDragTarget === target) {
            this.endCurrentDrag("image-reset");
        }

        if (imageState.resizeObserver) {
            imageState.resizeObserver.disconnect();
            this.globalResizeObservers.delete(imageState.resizeObserver);
        }

        // Restore attributes
        if (imageState.originalAttributes.viewBox !== null) {
            target.setAttribute("viewBox", imageState.originalAttributes.viewBox);
        } else {
            target.removeAttribute("viewBox");
        }

        if (imageState.originalAttributes.width !== null) {
            target.setAttribute("width", imageState.originalAttributes.width);
        } else {
            target.removeAttribute("width");
        }

        if (imageState.originalAttributes.height !== null) {
            target.setAttribute("height", imageState.originalAttributes.height);
        } else {
            target.removeAttribute("height");
        }

        if (imageState.originalAttributes.preserveAspectRatio !== null) {
            target.setAttribute("preserveAspectRatio", imageState.originalAttributes.preserveAspectRatio);
        } else {
            target.removeAttribute("preserveAspectRatio");
        }

        // Restore styles
        if (imageState.originalStyles.transform !== null) {
            target.style.transform = imageState.originalStyles.transform;
        } else {
            target.style.transform = "";
        }

        if (imageState.originalStyles.transformOrigin !== null) {
            target.style.transformOrigin = imageState.originalStyles.transformOrigin;
        } else {
            target.style.transformOrigin = "";
        }

        if (imageState.originalStyles.transition !== null) {
            target.style.transition = imageState.originalStyles.transition;
        } else {
            target.style.transition = "";
        }

        if (imageState.originalStyles.cursor !== null) {
            target.style.cursor = imageState.originalStyles.cursor;
        } else {
            target.style.cursor = "";
        }

        if (imageState.originalStyles.width !== null) {
            target.style.width = imageState.originalStyles.width;
        } else {
            target.style.width = "";
        }

        if (imageState.originalStyles.height !== null) {
            target.style.height = imageState.originalStyles.height;
        } else {
            target.style.height = "";
        }

        // Restore parent position using registry
        if (imageState.parentElement) {
            const registryEntry = this.parentRegistry.get(imageState.parentElement);
            if (registryEntry) {
                registryEntry.count--;
                if (registryEntry.count <= 0) {
                    imageState.parentElement.style.position = registryEntry.originalPosition;
                    this.parentRegistry.delete(imageState.parentElement);
                }
            }
        }

        target.classList.remove("image-zoom-drag-active");

        this.hideResetButton(target);
        this.zoomedImages.delete(target);
    }

    createResetButton(target: HTMLImageElement | SVGSVGElement): HTMLButtonElement {
        const button = target.ownerDocument.createElement('button');
        button.className = 'image-zoom-reset-btn';
        button.textContent = 'Reset';
        button.setAttribute('aria-label', 'Reset zoom and pan');

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            this.resetImage(target);
        });

        return button;
    }

    showResetButton(target: HTMLImageElement | SVGSVGElement) {
        if (!target) return;

        this.hideResetButton(target);

        const controlsContainer = target.ownerDocument.createElement("div");
        controlsContainer.className = "image-zoom-controls";

        const resetButton = this.createResetButton(target);

        controlsContainer.appendChild(resetButton);

        if (target.tagName.toLowerCase() === 'img') {
            const editButton = target.ownerDocument.createElement("button");
            editButton.className = "image-zoom-edit-btn";
            editButton.textContent = "✏️ Edit";
            editButton.title = "Open in external editor";
            editButton.addEventListener("click", async (e) => {
                e.stopPropagation();
                const file = await this.findFileFromImageElement(target as HTMLImageElement);
                if (file) await this.openImageInExternalApp(file);
            });
            controlsContainer.appendChild(editButton);
        }

        const parent = target.parentElement;
        if (parent) {
            // Apply reference counting for position relative
            let registryEntry = this.parentRegistry.get(parent);
            if (!registryEntry) {
                registryEntry = { count: 0, originalPosition: parent.style.position || "" };
                this.parentRegistry.set(parent, registryEntry);
                parent.style.position = "relative";
            }
            registryEntry.count++;

            parent.appendChild(controlsContainer);

            // Store button and container references in image state
            const imageState = this.zoomedImages.get(target);
            if (imageState) {
                imageState.resetButton = resetButton;
                imageState.controlsContainer = controlsContainer;
            }
        }
    }

    hideResetButton(target: HTMLImageElement | SVGSVGElement) {
        if (!target) return;

        const imageState = this.zoomedImages.get(target);
        if (imageState && imageState.controlsContainer) {
            imageState.controlsContainer.remove();
            imageState.controlsContainer = null;
            imageState.resetButton = null;
        }
    }

    isMouseWithinFrame(e: MouseEvent, target: HTMLImageElement | SVGSVGElement): boolean {
        if (!target) return false;
        const rect = target.getBoundingClientRect();
        return e.clientX >= rect.left && e.clientX <= rect.right &&
               e.clientY >= rect.top && e.clientY <= rect.bottom;
    }

    isImageFile(file: TFile) {
        const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'];
        return imageExtensions.includes(file.extension.toLowerCase());
    }
}

class ImageZoomSettingTab extends PluginSettingTab {
    plugin: ImageZoomDragPlugin;

    constructor(app: App, plugin: ImageZoomDragPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

        console.log("[Image Pan and Zoom] Settings tab rendered", {
            exclusiveImageHandling: this.plugin.settings.disableNativeImageInteractions
        });

        containerEl.createEl('h2', {text: 'Image Zoom & Drag Settings'});

        // Interaction Settings
        new Setting(containerEl)
            .setName('Exclusive image handling')
            .setDesc('Use this plugin instead of normal image opening and dragging in supported notes. Alt-click to activate pan and zoom. Right-click an image for plugin controls.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.disableNativeImageInteractions)
                .onChange(async (value) => {
                    await this.plugin.setExclusiveImageHandling(value, 'settings');
                }));

        new Setting(containerEl)
            .setName('Debug image interactions')
            .setDesc('Log interaction ownership and cleanup information to the developer console.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugImageInteractions)
                .onChange(async (value) => {
                    this.plugin.settings.debugImageInteractions = value;
                    await this.plugin.saveSettings();
                }));

        // Use system default toggle
        new Setting(containerEl)
            .setName('Use system default editor')
            .setDesc('Open images with the default system application')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useSystemDefault)
                .onChange(async (value) => {
                    this.plugin.settings.useSystemDefault = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide path input
                }));

        // Custom editor path (only show if not using default)
        if (!this.plugin.settings.useSystemDefault) {
            new Setting(containerEl)
                .setName('External editor executable')
                .setDesc('Path to the application executable, without command-line arguments or surrounding quotes.')
                .addText(text => text
                    .setPlaceholder('C:\\Program Files\\ShareX\\ShareX.exe')
                    .setValue(this.plugin.settings.externalEditorPath)
                    .onChange(async (value) => {
                        this.plugin.settings.externalEditorPath = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(containerEl)
                .setName('External editor arguments')
                .setDesc('Arguments passed to the editor. Use {file} for the selected image’s absolute path. Example: -ImageEditor "{file}"')
                .addText(text => text
                    .setPlaceholder('"{file}"')
                    .setValue(this.plugin.settings.externalEditorArguments)
                    .onChange(async (value) => {
                        this.plugin.settings.externalEditorArguments = value;
                        await this.plugin.saveSettings();
                    }));

            // Add examples
            containerEl.createEl('div', {
                text: 'Examples:',
                cls: 'setting-item-description'
            });
            containerEl.createEl('ul', {
                cls: 'external-editor-examples'
            }).innerHTML = `
                <li><strong>ShareX (Windows):</strong> Executable: ShareX.exe, Arguments: -ImageEditor "{file}"</li>
                <li><strong>MS Paint (Windows):</strong> Executable: mspaint.exe, Arguments: "{file}"</li>
                <li><strong>GIMP (Mac):</strong> Executable: /Applications/GIMP.app/Contents/MacOS/gimp, Arguments: "{file}"</li>
            `;
        }
    }
}
