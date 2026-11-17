import { Body, Controller, Get, HttpCode, Module, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { MongooseModule } from '@nestjs/mongoose';
import {
  documentListQuerySchema,
  documentReviewSchema,
  documentTypeSchema,
  uploadIntentSchema,
  type DocumentTypeView,
  type DocumentView,
  type UploadIntentResponse,
} from '@skillconnect/contracts';
import type { AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { CurrentUser, RequirePermissions } from '../../core/auth/decorators';
import { RateLimit } from '../../core/auth/rate-limit';
import { ReqContext } from '../../core/http/request-context';
import { ApiZodBody, ApiZodQuery, createZodDto } from '../../core/http/zod';
import {
  DOCUMENT_MODEL,
  DOCUMENT_TYPE_MODEL,
  documentSchema,
  documentTypeSchema as documentTypeMongoSchema,
  DocumentsService,
} from './documents.service';

class UploadIntentDto extends createZodDto(uploadIntentSchema) {}
class DocumentListQueryDto extends createZodDto(documentListQuerySchema) {}
class DocumentReviewDto extends createZodDto(documentReviewSchema) {}
class DocumentTypeDto extends createZodDto(documentTypeSchema) {}

@ApiTags('Documents')
@ApiBearerAuth()
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('types')
  types(): Promise<DocumentTypeView[]> {
    return this.documents.listTypes();
  }

  @Post('upload-intent')
  @RequirePermissions('document.upload')
  @RateLimit({ name: 'upload-intent', limit: 60, windowSeconds: 600, by: 'ip' })
  @ApiZodBody(UploadIntentDto)
  intent(@Body() dto: UploadIntentDto, @CurrentUser() user: AuthUser): Promise<UploadIntentResponse> {
    return this.documents.createUploadIntent(dto, user);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @RequirePermissions('document.upload')
  complete(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<DocumentView> {
    return this.documents.complete(id, user);
  }

  @Get()
  @RequirePermissions('document.read')
  @ApiZodQuery(DocumentListQueryDto)
  list(@Query() q: DocumentListQueryDto, @CurrentUser() user: AuthUser): Promise<DocumentView[]> {
    return this.documents.list(q.ownerType, q.ownerId, user, q.includeHistory === 'true');
  }

  @Get(':id')
  @RequirePermissions('document.read')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<DocumentView> {
    return this.documents.get(id, user);
  }

  @Get(':id/download-url')
  @RequirePermissions('document.read')
  downloadUrl(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<{ url: string; expiresAt: string }> {
    return this.documents.downloadUrl(id, user, ctx);
  }
}

@ApiTags('Documents (admin)')
@ApiBearerAuth()
@Controller('admin')
export class AdminDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post('documents/:id/review')
  @HttpCode(200)
  @RequirePermissions('document.verify')
  @ApiZodBody(DocumentReviewDto)
  review(
    @Param('id') id: string,
    @Body() dto: DocumentReviewDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<DocumentView> {
    return this.documents.review(id, dto, user, ctx);
  }

  @Get('document-types')
  @RequirePermissions('doctype.manage')
  types(): Promise<DocumentTypeView[]> {
    return this.documents.listTypes(true);
  }

  @Put('document-types')
  @RequirePermissions('doctype.manage')
  @ApiZodBody(DocumentTypeDto)
  save(
    @Body() dto: DocumentTypeDto,
    @CurrentUser() user: AuthUser,
    @ReqContext() ctx: AuditContext,
  ): Promise<DocumentTypeView> {
    return this.documents.upsertType(dto, user, ctx);
  }
}

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DOCUMENT_TYPE_MODEL, schema: documentTypeMongoSchema },
      { name: DOCUMENT_MODEL, schema: documentSchema },
    ]),
  ],
  controllers: [DocumentsController, AdminDocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
export { DocumentsService } from './documents.service';
