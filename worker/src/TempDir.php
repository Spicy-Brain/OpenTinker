<?php

declare(strict_types=1);

namespace OpenTinker;

/**
 * Private temporary directories. Each one is created fresh under a random
 * name with mode 0700 and never reused, so nothing another user planted in a
 * shared temp dir (such as a PsySH config.php) is ever read, and nobody else
 * can write into it.
 */
final class TempDir
{
    public static function create(string $parent): ?string
    {
        $parent = \rtrim($parent, '/\\');

        for ($attempt = 0; $attempt < 3; $attempt++) {
            try {
                $dir = $parent . \DIRECTORY_SEPARATOR . 'opentinker-' . \bin2hex(\random_bytes(8));
            } catch (\Throwable) {
                return null;
            }

            // mkdir fails when the name already exists in any form, including a symlink.
            if (@\mkdir($dir, 0700)) {
                return $dir;
            }
        }

        return null;
    }

    /** Removes a directory made by create(), without following symlinks. */
    public static function remove(string $dir): void
    {
        $entries = @\scandir($dir);

        foreach ($entries === false ? [] : $entries as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }

            $path = $dir . \DIRECTORY_SEPARATOR . $name;

            if (\is_dir($path) && ! \is_link($path)) {
                self::remove($path);
            } else {
                @\unlink($path);
            }
        }

        @\rmdir($dir);
    }
}
