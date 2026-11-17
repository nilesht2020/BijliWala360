import {
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  Param,
  Patch,
  Post,
  Query,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Schema, Types, type Model } from 'mongoose';
import { z } from 'zod';
import {
  categoryCreateSchema,
  categoryUpdateSchema,
  skillCreateSchema,
  skillUpdateSchema,
  type CategoryCreateInput,
  type CategoryUpdateInput,
  type CategoryView,
  type PublicCategoryDetail,
  type SkillCreateInput,
  type SkillUpdateInput,
  type SkillView,
} from '@skillconnect/contracts';
import { actorFromUser, AuditService, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, Public, RequirePermissions } from '../../core/auth/decorators';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { ReqContext } from '../../core/http/request-context';
import { ApiZodBody, createZodDto } from '../../core/http/zod';

/* ================================================================ schemas (DATABASE §6) */

export const CATEGORY_MODEL = 'ServiceCategory';
export const SKILL_MODEL = 'Skill';

interface CategoryDoc {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  parentId: Types.ObjectId | null;
  ancestors: Types.ObjectId[];
  level: 1 | 2 | 3;
  description?: string;
  imageUrl?: string;
  icon?: string;
  displayOrder: number;
  isActive: boolean;
  seo?: { title?: string; description?: string };
}

interface SkillDoc {
  _id: Types.ObjectId;
  code: string;
  name: string;
  categoryIds: Types.ObjectId[];
  requiredDocTypeCodes: string[];
  sacCode?: string;
  isActive: boolean;
}

const categorySchema = new Schema<CategoryDoc>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true },
    parentId: { type: Schema.Types.ObjectId, default: null },
    ancestors: { type: [Schema.Types.ObjectId], default: [] },
    level: { type: Number, enum: [1, 2, 3], required: true },
    description: String,
    imageUrl: String,
    icon: String,
    displayOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    seo: { type: new Schema({ title: String, description: String }, { _id: false }) },
  },
  { collection: 'service_categories', timestamps: true, versionKey: false },
);
categorySchema.index({ slug: 1 }, { unique: true });
categorySchema.index({ parentId: 1, displayOrder: 1 });
categorySchema.index({ ancestors: 1 });
categorySchema.index({ isActive: 1, level: 1 });
categorySchema.index({ name: 'text', description: 'text' });

const skillSchema = new Schema<SkillDoc>(
  {
    code: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    categoryIds: { type: [Schema.Types.ObjectId], default: [] },
    requiredDocTypeCodes: { type: [String], default: [] },
    sacCode: String,
    isActive: { type: Boolean, default: true },
  },
  { collection: 'skills', timestamps: true, versionKey: false },
);
skillSchema.index({ code: 1 }, { unique: true });
skillSchema.index({ categoryIds: 1 });
skillSchema.index({ name: 'text' });

/* ================================================================ service */

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function toCategoryView(c: CategoryDoc): CategoryView {
  return {
    id: c._id.toHexString(),
    name: c.name,
    slug: c.slug,
    parentId: c.parentId ? c.parentId.toHexString() : null,
    level: c.level,
    ...(c.description ? { description: c.description } : {}),
    ...(c.imageUrl ? { imageUrl: c.imageUrl } : {}),
    ...(c.icon ? { icon: c.icon } : {}),
    displayOrder: c.displayOrder,
    isActive: c.isActive,
  };
}

function toSkillView(s: SkillDoc): SkillView {
  return {
    id: s._id.toHexString(),
    code: s.code,
    name: s.name,
    categoryIds: s.categoryIds.map((c) => c.toHexString()),
    requiredDocTypeCodes: s.requiredDocTypeCodes,
    ...(s.sacCode ? { sacCode: s.sacCode } : {}),
    isActive: s.isActive,
  };
}

/** Builds a nested tree from a flat, ordered list (children keep their display order). */
export function buildTree(flat: CategoryView[]): CategoryView[] {
  const byId = new Map(flat.map((c) => [c.id, { ...c, children: [] as CategoryView[] }]));
  const roots: CategoryView[] = [];
  for (const c of byId.values()) {
    const parent = c.parentId ? byId.get(c.parentId) : undefined;
    if (parent) parent.children?.push(c);
    else if (!c.parentId) roots.push(c);
  }
  return roots;
}

const DEFAULT_CATEGORIES: Array<{ name: string; description: string; skills: Array<[string, string]> }> = [
  {
    name: 'Electrical',
    description: 'Wiring, panels, maintenance and installations.',
    skills: [
      ['ELECTRICIAN', 'Electrician'],
      ['HT_ELECTRICIAN', 'HT electrician'],
    ],
  },
  {
    name: 'Plumbing',
    description: 'Pipework, fixtures and water systems.',
    skills: [['PLUMBER', 'Plumber']],
  },
  {
    name: 'Housekeeping',
    description: 'Office, facility and site cleaning.',
    skills: [['HOUSEKEEPER', 'Housekeeping staff']],
  },
  {
    name: 'Security',
    description: 'Guards and supervisors for sites and offices.',
    skills: [['SECURITY_GUARD', 'Security guard']],
  },
  {
    name: 'HVAC',
    description: 'Air conditioning and ventilation.',
    skills: [['HVAC_TECHNICIAN', 'HVAC technician']],
  },
  {
    name: 'Carpentry',
    description: 'Furniture, fit-outs and repairs.',
    skills: [['CARPENTER', 'Carpenter']],
  },
];

/**
 * Service catalogue (SRS §4.4). Categories form a tree of at most 3 levels; categories are
 * deactivated rather than deleted (FR-CAT-04). A starter catalogue is seeded only on an empty
 * database so the public site is usable on first run.
 */
@Injectable()
export class CatalogService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    @InjectModel(CATEGORY_MODEL) private readonly categories: Model<CategoryDoc>,
    @InjectModel(SKILL_MODEL) private readonly skills: Model<SkillDoc>,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || (await this.categories.estimatedDocumentCount()) > 0) return;
    for (const [i, c] of DEFAULT_CATEGORIES.entries()) {
      try {
        const cat = await this.categories.create({
          name: c.name,
          slug: slugify(c.name),
          level: 1,
          displayOrder: i,
          description: c.description,
        });
        await this.skills.insertMany(
          c.skills.map(([code, name]) => ({ code, name, categoryIds: [cat._id] })),
        );
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
      }
    }
    this.logger.log('Seeded starter service catalogue');
  }

  /* ------------------------------ categories */

  async listCategories(includeInactive: boolean): Promise<CategoryView[]> {
    const docs = await this.categories
      .find(includeInactive ? {} : { isActive: true })
      .sort({ level: 1, displayOrder: 1, name: 1 })
      .lean<CategoryDoc[]>()
      .exec();
    // A category is only publicly visible when all of its ancestors are active too.
    const views = docs.map(toCategoryView);
    if (includeInactive) return views;
    const visible = new Set<string>();
    for (const v of views) if (!v.parentId || visible.has(v.parentId)) visible.add(v.id);
    return views.filter((v) => visible.has(v.id));
  }

  async getById(id: string): Promise<CategoryDoc> {
    const doc = Types.ObjectId.isValid(id)
      ? await this.categories.findById(id).lean<CategoryDoc>().exec()
      : null;
    if (!doc) throw new NotFoundError('Category', id);
    return doc;
  }

  async publicDetail(slug: string): Promise<PublicCategoryDetail> {
    const visible = await this.listCategories(false);
    const category = visible.find((c) => c.slug === slug);
    if (!category) throw new NotFoundError('Category', slug);
    const byId = new Map(visible.map((c) => [c.id, c]));
    const breadcrumbs: PublicCategoryDetail['breadcrumbs'] = [];
    for (
      let cur: CategoryView | undefined = category;
      cur;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    ) {
      breadcrumbs.unshift({ id: cur.id, name: cur.name, slug: cur.slug });
    }
    const children = visible.filter((c) => c.parentId === category.id);
    const ids = [
      category.id,
      ...visible
        .filter((c) => c.id !== category.id && this.isDescendant(c, category.id, byId))
        .map((c) => c.id),
    ];
    const skills = await this.skills
      .find({ isActive: true, categoryIds: { $in: ids.map((i) => new Types.ObjectId(i)) } })
      .sort({ name: 1 })
      .lean<SkillDoc[]>()
      .exec();
    return { category, children, skills: skills.map(toSkillView), breadcrumbs };
  }

  private isDescendant(c: CategoryView, ancestorId: string, byId: Map<string, CategoryView>): boolean {
    for (let p = c.parentId; p; p = byId.get(p)?.parentId ?? null) if (p === ancestorId) return true;
    return false;
  }

  async createCategory(input: CategoryCreateInput, user: AuthUser, ctx: AuditContext): Promise<CategoryView> {
    let level: 1 | 2 | 3 = 1;
    let ancestors: Types.ObjectId[] = [];
    if (input.parentId) {
      const parent = await this.getById(input.parentId);
      if (parent.level >= 3)
        throw new DomainError(
          'CATEGORY_DEPTH_EXCEEDED',
          'Categories can be nested at most three levels deep.',
        );
      level = (parent.level + 1) as 2 | 3;
      ancestors = [...parent.ancestors, parent._id];
    }
    const slug = input.slug ?? slugify(input.name);
    try {
      const doc = await this.categories.create({
        ...input,
        slug,
        parentId: input.parentId ? new Types.ObjectId(input.parentId) : null,
        ancestors,
        level,
      });
      await this.audit.record({
        actor: actorFromUser(user),
        action: 'category.create',
        entityType: 'ServiceCategory',
        entityId: doc._id.toHexString(),
        after: input,
        context: ctx,
      });
      return toCategoryView(doc.toObject());
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new DomainError(
          'STATE_CONFLICT',
          `The URL name "${slug}" is already used by another category.`,
          [{ field: 'slug' }],
        );
      }
      throw err;
    }
  }

  async updateCategory(
    id: string,
    input: CategoryUpdateInput,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<CategoryView> {
    const before = await this.getById(id);
    try {
      const doc = await this.categories
        .findByIdAndUpdate(before._id, { $set: input }, { new: true })
        .lean<CategoryDoc>()
        .exec();
      await this.audit.record({
        actor: actorFromUser(user),
        action: 'category.update',
        entityType: 'ServiceCategory',
        entityId: id,
        before: toCategoryView(before),
        after: input,
        context: ctx,
      });
      return toCategoryView(doc as CategoryDoc);
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new DomainError('STATE_CONFLICT', 'That URL name is already used.', [{ field: 'slug' }]);
      throw err;
    }
  }

  /* ------------------------------ skills */

  async listSkills(categoryId?: string, includeInactive = false): Promise<SkillView[]> {
    const filter: Record<string, unknown> = includeInactive ? {} : { isActive: true };
    if (categoryId) {
      if (!Types.ObjectId.isValid(categoryId)) return [];
      const id = new Types.ObjectId(categoryId);
      const descendants = await this.categories.find({ ancestors: id }, { _id: 1 }).lean().exec();
      filter.categoryIds = { $in: [id, ...descendants.map((d) => d._id)] };
    }
    const docs = await this.skills.find(filter).sort({ name: 1 }).lean<SkillDoc[]>().exec();
    return docs.map(toSkillView);
  }

  /** Used by provider modules: returns active skills by id (unknown/inactive ids are dropped). */
  async activeSkillsByIds(ids: string[]): Promise<SkillView[]> {
    const valid = ids.filter((i) => Types.ObjectId.isValid(i)).map((i) => new Types.ObjectId(i));
    const docs = await this.skills
      .find({ _id: { $in: valid }, isActive: true })
      .lean<SkillDoc[]>()
      .exec();
    return docs.map(toSkillView);
  }

  /** Id -> name maps for list views (catalogues are small; includes inactive entries). */
  async nameLookups(): Promise<{ categories: Map<string, string>; skills: Map<string, SkillView> }> {
    const [cats, skills] = await Promise.all([
      this.categories.find({}, { name: 1 }).lean<Pick<CategoryDoc, '_id' | 'name'>[]>().exec(),
      this.skills.find({}).lean<SkillDoc[]>().exec(),
    ]);
    return {
      categories: new Map(cats.map((c) => [c._id.toHexString(), c.name])),
      skills: new Map(skills.map((s) => [s._id.toHexString(), toSkillView(s)])),
    };
  }

  /** Throws unless every skill exists and is active. */
  async assertActiveSkills(ids: string[], field = 'lines'): Promise<SkillView[]> {
    const unique = [...new Set(ids)];
    const found = await this.activeSkillsByIds(unique);
    if (found.length !== unique.length)
      throw new DomainError('VALIDATION_FAILED', 'One or more skills are not available.', [{ field }]);
    return found;
  }

  async assertCategoriesExist(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const count = await this.categories.countDocuments({
      _id: { $in: ids.map((i) => new Types.ObjectId(i)) },
      isActive: true,
    });
    if (count !== new Set(ids).size)
      throw new DomainError('VALIDATION_FAILED', 'One or more categories do not exist.', [
        { field: 'categoryIds' },
      ]);
  }

  async createSkill(input: SkillCreateInput, user: AuthUser, ctx: AuditContext): Promise<SkillView> {
    await this.assertCategoriesExist(input.categoryIds);
    try {
      const doc = await this.skills.create({
        ...input,
        categoryIds: input.categoryIds.map((c) => new Types.ObjectId(c)),
      });
      await this.audit.record({
        actor: actorFromUser(user),
        action: 'skill.create',
        entityType: 'Skill',
        entityId: doc._id.toHexString(),
        after: input,
        context: ctx,
      });
      return toSkillView(doc.toObject());
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new DomainError('STATE_CONFLICT', `Skill code ${input.code} already exists.`, [
          { field: 'code' },
        ]);
      throw err;
    }
  }

  async updateSkill(
    id: string,
    input: SkillUpdateInput,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<SkillView> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Skill', id);
    if (input.categoryIds) await this.assertCategoriesExist(input.categoryIds);
    const doc = await this.skills
      .findByIdAndUpdate(
        id,
        {
          $set: {
            ...input,
            ...(input.categoryIds
              ? { categoryIds: input.categoryIds.map((c) => new Types.ObjectId(c)) }
              : {}),
          },
        },
        { new: true },
      )
      .lean<SkillDoc>()
      .exec();
    if (!doc) throw new NotFoundError('Skill', id);
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'skill.update',
      entityType: 'Skill',
      entityId: id,
      after: input,
      context: ctx,
    });
    return toSkillView(doc);
  }
}

/* ================================================================ controllers */

class CategoryCreateDto extends createZodDto(categoryCreateSchema) {}
class CategoryUpdateDto extends createZodDto(categoryUpdateSchema) {}
class SkillCreateDto extends createZodDto(skillCreateSchema) {}
class SkillUpdateDto extends createZodDto(skillUpdateSchema) {}
class PublicCategoriesQuery extends createZodDto(
  z
    .object({
      tree: z.enum(['true', 'false']).optional(),
      level: z.coerce.number().int().min(1).max(3).optional(),
    })
    .strict(),
) {}
class SkillsQuery extends createZodDto(z.object({ categoryId: z.string().max(24).optional() }).strict()) {}

@ApiTags('Catalogue')
@Controller('public')
@Public()
export class PublicCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  async categories(@Query() q: PublicCategoriesQuery): Promise<CategoryView[]> {
    const all = await this.catalog.listCategories(false);
    if (q.tree === 'true') return buildTree(all);
    return q.level ? all.filter((c) => c.level === q.level) : all;
  }

  @Get('categories/:slug')
  detail(@Param('slug') slug: string): Promise<PublicCategoryDetail> {
    return this.catalog.publicDetail(slug);
  }

  @Get('skills')
  skills(@Query() q: SkillsQuery): Promise<SkillView[]> {
    return this.catalog.listSkills(q.categoryId);
  }
}

@ApiTags('Catalogue (admin)')
@ApiBearerAuth()
@Controller('admin')
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  @RequirePermissions('category.manage')
  async categories(): Promise<CategoryView[]> {
    return buildTree(await this.catalog.listCategories(true));
  }

  @Post('categories')
  @RequirePermissions('category.manage')
  @ApiZodBody(CategoryCreateDto)
  createCategory(
    @Body() dto: CategoryCreateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<CategoryView> {
    return this.catalog.createCategory(dto, user, ctx);
  }

  @Patch('categories/:id')
  @RequirePermissions('category.manage')
  @ApiZodBody(CategoryUpdateDto)
  updateCategory(
    @Param('id') id: string,
    @Body() dto: CategoryUpdateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<CategoryView> {
    return this.catalog.updateCategory(id, dto, user, ctx);
  }

  @Get('skills')
  @RequirePermissions('skill.manage')
  skills(@Query() q: SkillsQuery): Promise<SkillView[]> {
    return this.catalog.listSkills(q.categoryId, true);
  }

  @Post('skills')
  @RequirePermissions('skill.manage')
  @ApiZodBody(SkillCreateDto)
  createSkill(
    @Body() dto: SkillCreateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<SkillView> {
    return this.catalog.createSkill(dto, user, ctx);
  }

  @Patch('skills/:id')
  @RequirePermissions('skill.manage')
  @ApiZodBody(SkillUpdateDto)
  updateSkill(
    @Param('id') id: string,
    @Body() dto: SkillUpdateDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<SkillView> {
    return this.catalog.updateSkill(id, dto, user, ctx);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CATEGORY_MODEL, schema: categorySchema },
      { name: SKILL_MODEL, schema: skillSchema },
    ]),
  ],
  controllers: [PublicCatalogController, AdminCatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
