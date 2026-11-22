#if !NET5_0_OR_GREATER
namespace System.Runtime.CompilerServices
{
    /// <summary>Enables init-only setters and records on older target frameworks.</summary>
    internal static class IsExternalInit
    {
    }
}
#endif
