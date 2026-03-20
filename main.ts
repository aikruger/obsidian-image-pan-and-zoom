import { Plugin, App, PluginSettingTab, Setting, Notice, TFile, FileSystemAdapter, Modal, Editor, TextComponent } from 'obsidian';

interface ImageBgConfig {
    [normalizedPath: string]: string;
}

interface ImageZoomSettings {
    externalEditorPath: string;
    useSystemDefault: boolean;
    defaultBg: string;
    imageBgConfig: ImageBgConfig;
    applyBgOnZoomOnly: boolean;
}

interface ImageState {
    isDragging: boolean;
    initialX: number;
    initialY: number;
    offsetX: number;
    offsetY: number;
    scale: number;
    resetButton: HTMLButtonElement | null;
    isSvg: boolean;
    originalViewBox: { x: number; y: number; width: number; height: number; } | null;
    svgViewBox: { x: number; y: number; width: number; height: number; } | null;
    resizeObserver: ResizeObserver | null;
    appliedBg: boolean;
}

const DEFAULT_SETTINGS: ImageZoomSettings = {
    externalEditorPath: '',
    useSystemDefault: true,
    defaultBg: '',
    imageBgConfig: {},
    applyBgOnZoomOnly: false
}

export default class ImageZoomDragPlugin extends Plugin {
    settings: ImageZoomSettings;
    // Multi-image state management
    private zoomedImages = new Map<HTMLImageElement | SVGSVGElement, ImageState>(); // Stores state for each zoomed image
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

        // Register markdown post-processor to apply background colours in "always show" mode
        this.registerMarkdownPostProcessor((element) => {
            if (this.settings.applyBgOnZoomOnly) return;
            element.querySelectorAll<HTMLImageElement>('.image-embed img').forEach((imgEl) => {
                this.applyBackgroundToContainer(imgEl);
            });
        });

        // Command: set background colour for the image embed at the cursor position
        this.addCommand({
            id: 'set-image-background-colour',
            name: 'Set background colour for image under cursor',
            editorCallback: (editor: Editor) => {
                const cursor = editor.getCursor();
                const line = editor.getLine(cursor.line);
                const imageMatch = line.match(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/);
                if (!imageMatch) {
                    new Notice('No image embed found at cursor position');
                    return;
                }
                const imageLinkPath = imageMatch[1].trim();
                const activeFile = this.app.workspace.getActiveFile();
                const resolved = this.app.metadataCache.getFirstLinkpathDest(
                    imageLinkPath,
                    activeFile?.path ?? ''
                );
                if (!(resolved instanceof TFile)) {
                    new Notice('Could not resolve image file: ' + imageLinkPath);
                    return;
                }
                new ImageBgColourModal(this.app, this, resolved).open();
            }
        });
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

        // Get the clean file path (remove any query parameters)
        let filePath = file.path;
        
        // Strip query parameters if present (e.g., ?timestamp)
        if (filePath.includes('?')) {
            filePath = filePath.split('?')[0];
        }

        // If using OneDrive or a sync folder, handle Win path decode
        if (this.app.vault.adapter instanceof FileSystemAdapter) {
            // Get full filesystem path (most reliable and works with OneDrive)
            const basePath = this.app.vault.adapter.getBasePath();
            filePath = require("path").join(basePath, filePath);
        }

        // Normalize path to clean any duplicate slashes and ensure proper format
        filePath = require("path").normalize(filePath);

        // Log the file path for debugging
        console.log("Opening image file:", filePath);
        console.log("Original file.path:", file.path);

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
            try {
                // On Windows, use shell: true to properly handle paths with spaces and simple executable names
                const isWindows = process.platform === 'win32';
                
                if (isWindows) {
                    // On Windows with shell, construct command string with proper quoting
                    const cmd = `"${editorPath}" "${filePath}"`;
                    spawn(cmd, { 
                        detached: true, 
                        stdio: 'ignore',
                        shell: true 
                    }).unref();
                } else {
                    // On non-Windows platforms, pass arguments as array
                    spawn(editorPath, [filePath], { 
                        detached: true, 
                        stdio: 'ignore'
                    }).unref();
                }
                new Notice("Image opened in external editor");
                console.log("Spawned external editor:", editorPath, "with file:", filePath);
            } catch (h) {
                new Notice("Failed to open external editor: " + h.message);
                console.error("External editor error:", h);
                console.error("Editor path:", editorPath);
                console.error("File path:", filePath);
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
        if (!e.altKey) return;
        if ((e.target as HTMLElement).closest(".modal, .suggestion-container, .mod-left-split, .mod-right-split")) return;

        const target = (e.target as HTMLElement).closest("img, svg");
        if (target instanceof HTMLImageElement || target instanceof SVGSVGElement) {
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
            const imageState: ImageState = {
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
                resizeObserver: null,
                appliedBg: false
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

            // Apply background colour when zoom is activated
            if (target instanceof HTMLImageElement) {
                const bg = this.applyBackgroundToContainer(target);
                if (bg) imageState.appliedBg = true;
            }
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
        if (!(target instanceof HTMLImageElement || target instanceof SVGSVGElement) || !this.zoomedImages.has(target)) return;

        const imageState = this.zoomedImages.get(target);
        if (!imageState || !this.isMouseWithinFrame(e, target) || !e.altKey) return;

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
        if (e.button !== 0 || !(target instanceof HTMLImageElement || target instanceof SVGSVGElement) || !this.zoomedImages.has(target)) return;

        const imageState = this.zoomedImages.get(target);
        if (!imageState || !this.isMouseWithinFrame(e, target) || !target.contains(e.target as Node)) return;

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

        // Remove background colour if in zoomed-only mode
        if (imageState.appliedBg && this.settings.applyBgOnZoomOnly && target instanceof HTMLImageElement) {
            const container = this.getImageContainer(target);
            if (container) {
                container.style.backgroundColor = '';
            }
        }

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

    normalizeImagePath(path: string): string {
        return path.replace(/\\/g, '/');
    }

    getImageBg(vaultPath: string): string {
        const normalized = this.normalizeImagePath(vaultPath);
        return this.settings.imageBgConfig[normalized] ?? this.settings.defaultBg ?? '';
    }

    /**
     * Applies the configured background colour to the container of an image element.
     * Checks for an inline `bg=<value>` directive in the img alt first, then the
     * persisted imageBgConfig, then the defaultBg setting.
     * Returns the applied colour string, or empty string if no bg was applied.
     */
    applyBackgroundToContainer(imgEl: HTMLImageElement): string {
        const inlineBg = this.parseInlineBg(imgEl);
        const vaultPath = this.resolveVaultPathFromElement(imgEl);
        const bg = inlineBg || (vaultPath ? this.getImageBg(vaultPath) : '');
        if (bg) {
            const container = this.getImageContainer(imgEl);
            if (container) {
                container.classList.add('image-pan-zoom-container');
                container.style.backgroundColor = bg;
            }
        }
        return bg;
    }

    resolveVaultPathFromElement(imgEl: HTMLImageElement): string | null {
        // Prefer the src attribute on the .image-embed wrapper (vault-relative path)
        const wrapper = imgEl.closest('.image-embed');
        if (wrapper) {
            const src = wrapper.getAttribute('src');
            if (src) return src;
        }
        // Fallback: parse the img src URL
        let src = imgEl.getAttribute('src');
        if (!src) return null;
        src = decodeURIComponent(src.split('?')[0]);
        // Try direct vault path lookup first
        const directFile = this.app.vault.getAbstractFileByPath(src);
        if (directFile instanceof TFile) return directFile.path;
        // Last resort: match by filename via metadata cache
        const filename = src.split('/').pop();
        if (filename) {
            const file = this.app.metadataCache.getFirstLinkpathDest(filename, '');
            if (file instanceof TFile) return file.path;
        }
        return null;
    }

    parseInlineBg(imgEl: HTMLImageElement): string | null {
        const alt = imgEl.getAttribute('alt') || '';
        // Matches `bg=<value>` in the alt text (e.g. from `![[image.png|bg=#ffffff]]`).
        // Allowed colour value characters: anything except whitespace, pipe, and comma.
        const bgMatch = alt.match(/\bbg=([^\s|,]+)/i);
        return bgMatch ? bgMatch[1] : null;
    }

    getImageContainer(target: HTMLImageElement): HTMLElement | null {
        return (target.closest('.image-embed') as HTMLElement) || target.parentElement;
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

        // Background colour settings
        containerEl.createEl('h3', { text: 'Background Colour' });

        let defaultBgText: TextComponent | undefined;
        new Setting(containerEl)
            .setName('Default background colour')
            .setDesc('Applied behind images without a specific override. Leave empty for transparent. Use any CSS colour value (e.g. #000000, transparent).')
            .addColorPicker(picker => {
                const hex = this.plugin.settings.defaultBg.match(/^#[0-9a-fA-F]{6}$/i)
                    ? this.plugin.settings.defaultBg : '#000000';
                picker.setValue(hex);
                picker.onChange(async (value) => {
                    this.plugin.settings.defaultBg = value;
                    if (defaultBgText) defaultBgText.setValue(value);
                    await this.plugin.saveSettings();
                });
            })
            .addText(text => {
                defaultBgText = text;
                text.setPlaceholder('transparent or #rrggbb')
                    .setValue(this.plugin.settings.defaultBg)
                    .onChange(async (value) => {
                        this.plugin.settings.defaultBg = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Apply background when zoomed only')
            .setDesc('When enabled, the background colour is only shown while an image is actively zoomed. When disabled, backgrounds are always visible.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.applyBgOnZoomOnly)
                .onChange(async (value) => {
                    this.plugin.settings.applyBgOnZoomOnly = value;
                    await this.plugin.saveSettings();
                }));
    }
}

class ImageBgColourModal extends Modal {
    plugin: ImageZoomDragPlugin;
    file: TFile;

    constructor(app: App, plugin: ImageZoomDragPlugin, file: TFile) {
        super(app);
        this.plugin = plugin;
        this.file = file;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Set background colour' });
        contentEl.createEl('p', { text: `Image: ${this.file.name}`, cls: 'setting-item-description' });

        const normalized = this.plugin.normalizeImagePath(this.file.path);
        const currentBg = this.plugin.settings.imageBgConfig[normalized] ?? '';
        let colourValue = currentBg;

        let textComp: TextComponent | undefined;
        new Setting(contentEl)
            .setName('Colour')
            .setDesc('CSS colour value (e.g. #ffffff, transparent, rgba(0,0,0,0.5)). The colour picker handles solid hex colours; use the text field for other values.')
            .addColorPicker(picker => {
                const hex = currentBg.match(/^#[0-9a-fA-F]{6}$/i) ? currentBg : '#000000';
                picker.setValue(hex);
                picker.onChange(value => {
                    colourValue = value;
                    if (textComp) textComp.setValue(value);
                });
            })
            .addText(text => {
                textComp = text;
                text.setPlaceholder('transparent or #rrggbb')
                    .setValue(currentBg)
                    .onChange(value => { colourValue = value; });
            });

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText('Clear override')
                .setWarning()
                .onClick(async () => {
                    delete this.plugin.settings.imageBgConfig[normalized];
                    await this.plugin.saveSettings();
                    this.close();
                    new Notice('Background colour override removed for ' + this.file.name);
                }))
            .addButton(btn => btn
                .setButtonText('Save')
                .setCta()
                .onClick(async () => {
                    const trimmed = colourValue.trim();
                    if (trimmed) {
                        this.plugin.settings.imageBgConfig[normalized] = trimmed;
                    } else {
                        delete this.plugin.settings.imageBgConfig[normalized];
                    }
                    await this.plugin.saveSettings();
                    this.close();
                    new Notice(`Background colour ${trimmed ? 'saved' : 'cleared'} for ${this.file.name}`);
                }));
    }

    onClose() {
        this.contentEl.empty();
    }
}
