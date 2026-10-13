import re

with open('src/image-interaction-controller.ts', 'r') as f:
    content = f.read()

# Make sure we don't accidentally intercept normal right click without suppression turned on.
# We already handle that with:
# if (event.type === 'contextmenu') {
#    if (isTakeover && this.isContextMenuSuppressed()) {
#        this.consumeEvent(event);
# ...

# Looks good.
