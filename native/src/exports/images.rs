//! 图像管理系统（Image Library）NAPI 导出。
//!
//! 供主进程 IPC 调用：查询图库列表、读取图片 data URL、删除图片
//! （删除时同步重写会话消息中的图片引用）。

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::storage::{ImageLibraryRecord};

fn map_spawn_error(error: tokio::task::JoinError) -> Error {
    Error::new(
        Status::GenericFailure,
        format!("Spawned blocking task failed: {error}"),
    )
}

/// 图库根目录绝对路径（`~/.snowapp/image`，跨平台一致）。
#[napi]
pub async fn get_image_library_root() -> napi::Result<String> {
    tokio::task::spawn_blocking(crate::storage::get_image_library_root)
        .await
        .map_err(map_spawn_error)?
}

/// 读取图库自定义保存目录（空字符串表示使用默认目录）。
#[napi]
pub async fn get_image_library_dir() -> napi::Result<String> {
    tokio::task::spawn_blocking(crate::storage::get_image_library_dir)
        .await
        .map_err(map_spawn_error)?
}

/// 设置图库自定义保存目录（传入空字符串重置为默认目录）。
#[napi]
pub async fn set_image_library_dir(dir: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::set_image_library_dir(dir))
        .await
        .map_err(map_spawn_error)?
}

/// 列出图库全部图片（按创建时间倒序）。
#[napi]
pub async fn list_image_library() -> napi::Result<Vec<ImageLibraryRecord>> {
    tokio::task::spawn_blocking(crate::storage::list_image_library)
        .await
        .map_err(map_spawn_error)?
}

/// 读取图库图片并返回 data URL；路径非法或文件不存在返回 None。
#[napi]
pub async fn read_image_library_file(relative_path: String) -> napi::Result<Option<String>> {
    tokio::task::spawn_blocking(move || crate::storage::read_image_library_file(&relative_path))
        .await
        .map_err(map_spawn_error)?
}

/// 删除图片：物理文件 + 索引 + 同步重写引用该图的会话消息。
#[napi]
pub async fn delete_image_library_image(id: String) -> napi::Result<()> {
    tokio::task::spawn_blocking(move || crate::storage::delete_image_library_image(&id))
        .await
        .map_err(map_spawn_error)?
}

/// 统计指定会话中引用的图库图片数量（删除会话确认框展示用）。
#[napi]
pub async fn count_conversation_images(
    conversation_ids: Vec<String>,
) -> napi::Result<i64> {
    tokio::task::spawn_blocking(move || crate::storage::count_conversation_images(conversation_ids))
        .await
        .map_err(map_spawn_error)?
}

/// 级联删除指定会话中引用的图库图片（物理文件 + 索引行）。
/// 由删除会话流程调用（选择不保留图片时）。
#[napi]
pub async fn delete_conversation_images(
    conversation_ids: Vec<String>,
) -> napi::Result<i64> {
    tokio::task::spawn_blocking(move || {
        crate::storage::delete_conversation_images(conversation_ids)
    })
    .await
    .map_err(map_spawn_error)?
}
