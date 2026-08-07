use serde::Serialize;

/// A symbol definition or reference location.
#[derive(Debug, Clone, Serialize)]
pub struct SymbolLocation {
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

/// Information about a symbol discovered during analysis.
#[derive(Debug, Clone, Serialize)]
pub struct SymbolInfo {
    pub name: String,
    pub kind: String,
    pub location: SymbolLocation,
    /// Container name, e.g. the enclosing class or module.
    pub container_name: Option<String>,
    /// Whether this symbol is exported from its file/module.
    pub is_exported: bool,
}

/// A reference to a symbol (usage site).
#[derive(Debug, Clone, Serialize)]
pub struct ReferenceInfo {
    pub location: SymbolLocation,
    /// "read", "write", or "read-write"
    pub access: String,
}

/// A symbol outline entry for a single file.
#[derive(Debug, Clone, Serialize)]
pub struct OutlineEntry {
    pub name: String,
    pub kind: String,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub container_name: Option<String>,
    pub is_exported: bool,
    pub children: Vec<OutlineEntry>,
}

/// The kind of a symbol, mapped to a human-readable string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    Function,
    Class,
    Method,
    Property,
    Variable,
    Constant,
    Interface,
    Type,
    Enum,
    EnumMember,
    Module,
    Constructor,
    Parameter,
    Import,
}

impl SymbolKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SymbolKind::Function => "function",
            SymbolKind::Class => "class",
            SymbolKind::Method => "method",
            SymbolKind::Property => "property",
            SymbolKind::Variable => "variable",
            SymbolKind::Constant => "constant",
            SymbolKind::Interface => "interface",
            SymbolKind::Type => "type",
            SymbolKind::Enum => "enum",
            SymbolKind::EnumMember => "enum-member",
            SymbolKind::Module => "module",
            SymbolKind::Constructor => "constructor",
            SymbolKind::Parameter => "parameter",
            SymbolKind::Import => "import",
        }
    }
}

/// Result of analyzing a single file.
pub struct AnalyzedFile {
    pub file_path: String,
    pub source_text: String,
    pub symbols: Vec<SymbolInfo>,
    pub references: Vec<(String, ReferenceInfo)>,
    pub unresolved_references: Vec<(String, ReferenceInfo)>,
}
