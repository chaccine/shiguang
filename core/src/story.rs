//! Ordered story content. Each story describes one snapshot of a record.

use crate::json::Json;
use crate::model::{req_opt_str, req_str, PhotoUse, Snapshot};
use std::collections::BTreeSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextRun {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
}

impl TextRun {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            bold: false,
            italic: false,
        }
    }

    fn from_json(value: &Json) -> Result<Self, String> {
        expect_fields(value, &["text", "bold", "italic"])?;
        let flag = |key| {
            value
                .get(key)
                .and_then(Json::as_bool)
                .ok_or_else(|| format!("字段 {key} 必须是布尔值"))
        };
        Ok(Self {
            text: req_str(value, "text")?,
            bold: flag("bold")?,
            italic: flag("italic")?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StoryBlock {
    Paragraph(Vec<TextRun>),
    Photo(PhotoUse),
    SmallHeading(Vec<TextRun>),
    Quote(Vec<TextRun>),
    Divider,
}

impl StoryBlock {
    fn runs(&self) -> Option<&[TextRun]> {
        match self {
            Self::Paragraph(runs) | Self::SmallHeading(runs) | Self::Quote(runs) => Some(runs),
            Self::Divider | Self::Photo(_) => None,
        }
    }

    fn from_json(value: &Json) -> Result<Self, String> {
        let runs = || -> Result<Vec<TextRun>, String> {
            expect_fields(value, &["kind", "runs"])?;
            value
                .get("runs")
                .and_then(Json::as_arr)
                .ok_or("字段 runs 必须是数组")?
                .iter()
                .map(TextRun::from_json)
                .collect()
        };
        match value.get("kind").and_then(Json::as_str) {
            Some("paragraph") => Ok(Self::Paragraph(runs()?)),
            Some("smallHeading") => Ok(Self::SmallHeading(runs()?)),
            Some("quote") => Ok(Self::Quote(runs()?)),
            Some("divider") => {
                expect_fields(value, &["kind"])?;
                Ok(Self::Divider)
            }
            Some("photo") => {
                expect_fields(value, &["kind", "photoUse"])?;
                let photo = value.get("photoUse").ok_or("缺少 photoUse")?;
                expect_fields(
                    photo,
                    &[
                        "photoUseId",
                        "assetId",
                        "caption",
                        "sha256",
                        "bytes",
                        "mediaType",
                    ],
                )?;
                Ok(Self::Photo(PhotoUse::from_json(photo)?))
            }
            _ => Err("故事块 kind 缺失或不受支持".into()),
        }
    }
}

// A misspelled mark or an unexpected payload on a divider must not disappear on read.
fn expect_fields(value: &Json, keys: &[&str]) -> Result<(), String> {
    if let Json::Obj(fields) = value {
        if fields.len() == keys.len() && keys.iter().all(|key| value.get(key).is_some()) {
            return Ok(());
        }
    }
    Err(format!("故事对象需要这些字段：{}", keys.join(", ")))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StoryComplexity {
    Simple,
    Complex,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Story {
    blocks: Vec<StoryBlock>,
    cover_photo_use_id: Option<String>,
}

impl Story {
    pub fn new(
        blocks: Vec<StoryBlock>,
        cover_photo_use_id: Option<String>,
    ) -> Result<Self, String> {
        let story = Self {
            blocks,
            cover_photo_use_id,
        };
        let mut ids = BTreeSet::new();
        for photo in story.photos() {
            if photo.photo_use_id.trim().is_empty() || photo.asset_id.trim().is_empty() {
                return Err("照片使用位置和原图 ID 必须非空".into());
            }
            PhotoUse::validate_sha256(&photo.sha256)?;
            if !ids.insert(photo.photo_use_id.as_str()) {
                return Err("故事中 photoUseId 重复".into());
            }
        }
        match story.cover_photo_use_id() {
            None if ids.is_empty() => Ok(story),
            Some(id) if ids.contains(id) => Ok(story),
            _ => Err("封面必须指向本故事中的照片使用位置".into()),
        }
    }

    /// Copy just the legacy content. Embedded line breaks belong to the single paragraph.
    pub fn from_legacy(snapshot: &Snapshot) -> Result<Self, String> {
        let mut blocks = Vec::new();
        if !snapshot.body.is_empty() {
            blocks.push(StoryBlock::Paragraph(vec![TextRun::plain(&snapshot.body)]));
        }
        blocks.extend(snapshot.photos.iter().cloned().map(StoryBlock::Photo));
        Self::new(blocks, snapshot.cover_photo_use_id.clone())
    }

    /// Decode an in-memory block sequence at the typed boundary.
    pub fn from_json(value: &Json) -> Result<Self, String> {
        expect_fields(value, &["blocks", "coverPhotoUseId"])?;
        let blocks = value
            .get("blocks")
            .and_then(Json::as_arr)
            .ok_or("字段 blocks 必须是数组")?
            .iter()
            .map(StoryBlock::from_json)
            .collect::<Result<_, _>>()?;
        Self::new(blocks, req_opt_str(value, "coverPhotoUseId")?)
    }

    pub fn blocks(&self) -> &[StoryBlock] {
        &self.blocks
    }

    pub fn cover_photo_use_id(&self) -> Option<&str> {
        self.cover_photo_use_id.as_deref()
    }

    /// Captions and integrity metadata travel with their occurrence in story order.
    pub fn photos(&self) -> impl Iterator<Item = &PhotoUse> {
        self.blocks.iter().filter_map(|block| match block {
            StoryBlock::Photo(photo) => Some(photo),
            _ => None,
        })
    }

    pub fn complexity(&self) -> StoryComplexity {
        let simple = self
            .blocks
            .iter()
            .enumerate()
            .all(|(index, block)| match block {
                StoryBlock::Paragraph(runs) => {
                    index == 0 && runs.iter().all(|r| !r.bold && !r.italic)
                }
                StoryBlock::Photo(_) => true,
                StoryBlock::SmallHeading(_) | StoryBlock::Quote(_) | StoryBlock::Divider => false,
            });
        if simple {
            StoryComplexity::Simple
        } else {
            StoryComplexity::Complex
        }
    }

    pub fn plain_text(&self) -> String {
        let mut text = String::new();
        for (index, runs) in self.blocks.iter().filter_map(StoryBlock::runs).enumerate() {
            if index > 0 {
                text.push('\n');
            }
            for run in runs {
                text.push_str(&run.text);
            }
        }
        text
    }

    /// The content minimum for a formal record. Date and stored original bytes are checked at commit.
    pub fn has_content(&self) -> bool {
        self.photos().next().is_some()
            || self
                .blocks
                .iter()
                .filter_map(StoryBlock::runs)
                .flatten()
                .any(|run| !run.text.trim().is_empty())
    }
}
