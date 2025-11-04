import { Plugin, App, PluginSettingTab, Setting, Notice, TFile, FileSystemAdapter } from 'obsidian';

interface ImageZoomSettings {
    externalEditorPath: string;
    useSystemDefault: boolean;
}

const DEFAULT_SETTINGS: ImageZoomSettings = {
    externalEditorPath: '',
    useSystemDefault: true
}

export default class ImageZoomDragPlugin extends Plugin {
    settings: ImageZoomSettings;
    // Multi-image state management
    private zoomedImages = new Map<HTMLImageElement | SVGSVGElement, any>(); // Stores state for each zoomed image
    private currentDragTarget: HTMLImageElement | SVGSVGElement | null = null; // Track which image is currently being dragged
    private globalResizeObservers = new Set<ResizeObserver>(); // Track all resize observers
    private resizeObserver: ResizeObserver | null = null;


    async onload() {
        await this.loadSettings();

        this.addSettingTab(new ImageZoomSettingTab(this.app, this));

        this.registerDomEvent(document, 'click', this.handleImageClick.bind(this));
        this.registerDomEvent(document, 'wheel', this.handleWheel.bind(this), { passive: false });
        this.registerDomEvent(document, 'mousedown', this.handleMouseDown.bind(this));
        this.registerDomEvent(document, 'mousemove', this.handleMouseMove.bind(this));
        this.registerDomEvent(document, 'mouseup', this.handleMouseUp.bind(this));

        // Add Escape key handler for reset
        this.registerDomEvent(document, 'keydown', (e) => {
            if (e.key === 'Escape' && this.zoomedImages.size > 0) {
                // Reset all zoomed images when Escape is pressed
                this.zoomedImages.forEach((imageState, target) => {
                    this.resetImage(target);
                });
            }
        });

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                this.zoomedImages.forEach((imageState, target) => {
                    if (target instanceof HTMLImageElement && file instanceof TFile) {
                        const imageSrc = target.getAttribute('src');
                        if (!imageSrc) return;

                        const sanitizedSrc = decodeURIComponent(imageSrc.split('?')[0]);

                        if (file.path === sanitizedSrc) {
                            // Refresh the image
                            const timestamp = new Date().getTime();
                            target.src = file.path + '?t=' + timestamp;
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
        // Clean up all resize observers
        this.globalResizeObservers.forEach(observer => observer.disconnect());
        this.globalResizeObservers.clear();

        // Reset all zoomed images
        this.zoomedImages.forEach((imageState, target) => {
            this.resetImage(target);
        });
        this.zoomedImages.clear();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async openImageInExternalApp(file: TFile) {
        if (!file) {
            new Notice("Could not locate image file in vault");
            return;
        }

        let resourcePath = this.app.vault.adapter.getResourcePath(file.path);
        resourcePath = resourcePath.replace(/^app:\/\/local\//, '');
        resourcePath = decodeURI(resourcePath);

        if (this.settings.useSystemDefault) {
            require("electron").shell.openPath(resourcePath)
                .then(() => {
                    new Notice("Image opened in external app");
                })
                .catch((err: any) => {
                    new Notice("Failed to open image: " + err.message);
                    console.error("Error opening image:", err);
                    console.error("Path attempted:", resourcePath);
                });
        } else {
            const editorPath = this.settings.externalEditorPath;
            if (!editorPath) {
                new Notice("Please configure external editor path in settings");
                return;
            }
            const { spawn } = require("child_process");
            try {
                spawn(editorPath, [resourcePath], { detached: true, stdio: 'ignore' }).unref();
                new Notice("Image opened in external editor");
            } catch (h) {
                new Notice("Failed to open external editor: " + h.message);
                console.error("External editor error:", h);
            }
        }
    }

    async findFileFromImageElement(imageElement: HTMLImageElement): Promise<TFile | null> {
        let src = imageElement.getAttribute("src");
        if (!src) {
            new Notice("Could not get image source");
            return null;
        }
        src = decodeURIComponent(src.split("?")[0]);
        let file = this.app.vault.getAbstractFileByPath(src);
        if (!file) {
            let filename = src.split("/").pop();
            let allFiles = this.app.vault.getFiles();
            file = allFiles.find(f => f.name === filename) || null;
        }
        return file as TFile;
    }

    handleImageClick(e: MouseEvent) {
        if ((e.target as HTMLElement).closest(".modal, .suggestion-container, .mod-left-split, .mod-right-split")) return;

        let target = (e.target as HTMLElement).closest("img, svg");
        if (target && (target instanceof HTMLImageElement || target instanceof SVGSVGElement)) {
            let workspaceSplit = target.closest(".workspace-split");
            if (!workspaceSplit ||
                workspaceSplit.classList.contains("mod-left-split") ||
                workspaceSplit.classList.contains("mod-right-split") ||
                !target.closest(".workspace-leaf-content")) return;

            // Check if this image is already zoomed
            if (this.zoomedImages.has(target)) {
                // Image is already zoomed, do nothing (keep zoom persistent)
                return;
            }

            // Create new zoom state for this image
            const imageState = {
                isDragging: false,
                initialX: 0,
                initialY: 0,
                offsetX: 0,
                offsetY: 0,
                scale: 1,
                resetButton: null,
                isSvg: target instanceof SVGSVGElement,
                originalViewBox: null,
                svgViewBox: null,
                resizeObserver: null
            };

            // Handle SVG-specific setup
            if (imageState.isSvg) {
                const svg = target as SVGSVGElement;
                const viewBox = svg.getAttribute("viewBox");
                if (viewBox) {
                    imageState.originalViewBox = this.parseViewBox(viewBox);
                    if (imageState.originalViewBox) {
                        imageState.svgViewBox = { ...imageState.originalViewBox };
                    }
                }
                imageState.resizeObserver = this.setupDynamicResize(svg);
                if (imageState.resizeObserver) {
                    this.globalResizeObservers.add(imageState.resizeObserver);
                }
            }

            // Store state and activate zoom
            this.zoomedImages.set(target, imageState);
            target.classList.add("image-zoom-drag-active");
            target.style.cursor = "grab";
            this.showResetButton(target);
        }
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

    handleWheel(e: WheelEvent) {
        const target = (e.target as HTMLElement).closest("img, svg");
        if (!target || !this.zoomedImages.has(target)) return;

        const imageState = this.zoomedImages.get(target);
        if (!this.isMouseWithinFrame(e, target) || !e.altKey) return;

        e.preventDefault();
        e.stopPropagation();

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

    handleMouseDown(e: MouseEvent) {
        const target = (e.target as HTMLElement).closest("img, svg");
        if (e.button !== 0 || !target || !this.zoomedImages.has(target)) return;

        const imageState = this.zoomedImages.get(target);
        if (!this.isMouseWithinFrame(e, target) || !target.contains(e.target as Node)) return;

        if ((e.target as HTMLElement).closest(".image-zoom-reset-btn")) return;

        this.currentDragTarget = target;
        imageState.isDragging = true;
        imageState.initialX = e.clientX - imageState.offsetX;
        imageState.initialY = e.clientY - imageState.offsetY;
        target.classList.add("is-dragging");
        e.preventDefault();
    }

    handleMouseMove(e: MouseEvent) {
        if (!this.currentDragTarget) return;

        const imageState = this.zoomedImages.get(this.currentDragTarget);
        if (!imageState || !imageState.isDragging) return;

        const rect = this.currentDragTarget.getBoundingClientRect();
        const buffer = 100;
        if (e.clientX < rect.left - buffer || e.clientX > rect.right + buffer ||
            e.clientY < rect.top - buffer || e.clientY > rect.bottom + buffer) {
            imageState.isDragging = false;
            this.currentDragTarget.classList.remove("is-dragging");
            this.currentDragTarget = null;
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

    handleMouseUp(e: MouseEvent) {
        if (this.currentDragTarget) {
            const imageState = this.zoomedImages.get(this.currentDragTarget);
            if (imageState && imageState.isDragging) {
                imageState.isDragging = false;
                this.currentDragTarget.classList.remove("is-dragging");
            }
            this.currentDragTarget = null;
        }
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

        if (imageState.resizeObserver) {
            imageState.resizeObserver.disconnect();
            this.globalResizeObservers.delete(imageState.resizeObserver);
        }

        if (imageState.isSvg && imageState.originalViewBox) {
            (target as SVGSVGElement).setAttribute("viewBox", `${imageState.originalViewBox.x} ${imageState.originalViewBox.y} ${imageState.originalViewBox.width} ${imageState.originalViewBox.height}`);
            target.removeAttribute("width");
            target.removeAttribute("height");
            target.style.width = "";
            target.style.height = "";
        }

        target.style.transform = "";
        target.style.cursor = "default";
        target.style.transition = "";
        target.classList.remove("image-zoom-drag-active");

        this.hideResetButton(target);
        this.zoomedImages.delete(target);
    }

    createResetButton(target: HTMLImageElement | SVGSVGElement): HTMLButtonElement {
        const button = document.createElement('button');
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

        const controlsContainer = document.createElement("div");
        controlsContainer.className = "image-zoom-controls";

        const resetButton = this.createResetButton(target);

        controlsContainer.appendChild(resetButton);

        if (target instanceof HTMLImageElement) {
            const editButton = document.createElement("button");
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
            parent.style.position = "relative";
            parent.appendChild(controlsContainer);

            // Store button reference in image state
            const imageState = this.zoomedImages.get(target);
            if (imageState) imageState.resetButton = resetButton;
        }
    }

    hideResetButton(target: HTMLImageElement | SVGSVGElement) {
        if (!target) return;

        const parent = target.parentElement;
        if (parent) {
            const existingControls = parent.querySelector(".image-zoom-controls");
            if (existingControls) existingControls.remove();
        }

        const imageState = this.zoomedImages.get(target);
        if (imageState) imageState.resetButton = null;
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

        containerEl.createEl('h2', {text: 'Image Zoom & Drag Settings'});

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
                .setName('External editor path')
                .setDesc('Full path to your image editor (e.g., C:\\Windows\\System32\\mspaint.exe or /usr/bin/gimp)')
                .addText(text => text
                    .setPlaceholder('C:\\Program Files\\Adobe\\Photoshop\\photoshop.exe')
                    .setValue(this.plugin.settings.externalEditorPath)
                    .onChange(async (value) => {
                        this.plugin.settings.externalEditorPath = value;
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
                <li><strong>MS Paint (Windows):</strong> mspaint.exe</li>
                <li><strong>Paint.NET (Windows):</strong> C:\\Program Files\\paint.net\\PaintDotNet.exe</li>
                <li><strong>GIMP (Windows):</strong> C:\\Program Files\\GIMP 2\\bin\\gimp-2.10.exe</li>
                <li><strong>GIMP (Mac):</strong> /Applications/GIMP.app/Contents/MacOS/gimp</li>
                <li><strong>Preview (Mac):</strong> open -a Preview</li>
            `;
        }
    }
}
