import { ArrowRight, Wrench } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

export interface CategoryCardData {
  slug: string;
  name: string;
  description?: string;
  imageUrl?: string;
}

/** Built-in thumbnails (public/images/services) for the starter catalogue's category slugs. */
const DEFAULT_THUMBNAILS = new Set([
  'electrical',
  'plumbing',
  'housekeeping',
  'security',
  'hvac',
  'carpentry',
]);

/** The admin-uploaded image if set, else a built-in thumbnail for known slugs. */
export function categoryImage(category: CategoryCardData): string | undefined {
  if (category.imageUrl) return category.imageUrl;
  return DEFAULT_THUMBNAILS.has(category.slug) ? `/images/services/${category.slug}.webp` : undefined;
}

/**
 * Large-image rounded service card for the public catalogue (UI direction: original design,
 * no third-party assets). Falls back to a tinted illustration block when no image is set.
 */
export function ServiceCategoryCard({
  category,
  className,
}: {
  category: CategoryCardData;
  className?: string;
}) {
  const image = categoryImage(category);
  return (
    <Link
      to={`/services/${category.slug}`}
      className={cn(
        'group flex flex-col overflow-hidden rounded-2xl border bg-card shadow-card transition-all hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-accent">
        {image ? (
          <img
            src={image}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-accent to-secondary">
            <Wrench className="size-10 text-primary/60" aria-hidden />
          </div>
        )}
      </div>
      <div className="flex flex-1 items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <h3 className="font-semibold leading-tight">{category.name}</h3>
          {category.description && (
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{category.description}</p>
          )}
        </div>
        <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
      </div>
    </Link>
  );
}
