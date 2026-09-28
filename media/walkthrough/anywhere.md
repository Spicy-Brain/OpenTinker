# Run code from anywhere

**Selection or line.** In any PHP file, select some code, or put the cursor on a line,
and press **Cmd+Shift+Enter** (**Ctrl+Shift+Enter**). The file's `use` statements are
applied first, without running the rest of the file.

**CodeLens.** Eloquent models get **Tinker this model**, and public methods that take no
arguments get **Run method**. Turn either off with `opentinker.codeLens.*`.

**Snippets.** Save code as a snippet and it lands in `.tinker/snippets/`, ready to
commit. Placeholders become a form when the snippet runs:

```php
<?php

/**
 * @name Refund an order
 * @description Refund an order and email the customer
 */

$order = Order::findOrFail({{orderId:number}});
$order->refund(notify: {{notify:bool}});
```
